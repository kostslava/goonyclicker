'use client';

import { useEffect, useRef, useState } from 'react';

const SMOOTHING_WINDOW = 3;
const MOVEMENT_THRESHOLD = 0.02; // Minimum movement to register direction change

export default function RepCounter() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [repCount, setRepCount] = useState(0);
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState('');

  const handLandmarkerRef = useRef<any>(null);
  const stateRef = useRef<'idle' | 'moving_up' | 'moving_down'>('idle');
  const handHeightRef = useRef(0.5);
  const handHistoryRef = useRef<number[]>([]);
  const lastHandYRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  // Initialize MediaPipe HandLandmarker
  useEffect(() => {
    let mounted = true;
    
    const initHandLandmarker = async () => {
      try {
        console.log('Starting MediaPipe HandLandmarker initialization...');
        
        const mediapipe = await import('@mediapipe/tasks-vision');
        const { HandLandmarker, FilesetResolver } = mediapipe;
        console.log('MediaPipe modules imported');
        
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm'
        );
        console.log('FilesetResolver initialized');
        
        const landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
          },
          runningMode: 'VIDEO',
          numHands: 2,
        });
        
        console.log('HandLandmarker created successfully');
        
        if (mounted) {
          handLandmarkerRef.current = landmarker;
          setIsInitialized(true);
        }
      } catch (err: any) {
        console.error('MediaPipe initialization failed:', err);
        if (mounted) {
          setError('Failed to initialize hand detection. Please refresh the page.');
        }
      }
    };

    initHandLandmarker();
    
    return () => {
      mounted = false;
    };

    return () => {
      if (handLandmarkerRef.current) {
        handLandmarkerRef.current.close();
      }
    };
  }, []);

  // Initialize webcam
  useEffect(() => {
    const initCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error('Camera access denied:', err);
        setError('Camera access denied. Please enable webcam permissions.');
      }
    };

    if (isInitialized) {
      initCamera();
    }

    return () => {
      if (videoRef.current?.srcObject) {
        const tracks = (videoRef.current.srcObject as MediaStream).getTracks();
        tracks.forEach((track) => track.stop());
      }
    };
  }, [isInitialized]);

  // Play pop sound
  const playPopSound = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }

    const ctx = audioContextRef.current;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.frequency.setValueAtTime(800, now);
    osc.frequency.exponentialRampToValueAtTime(400, now + 0.1);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

    osc.start(now);
    osc.stop(now + 0.1);
  };

  // Calculate moving average
  const getSmoothedHandHeight = (newHeight: number): number => {
    handHistoryRef.current.push(newHeight);
    if (handHistoryRef.current.length > SMOOTHING_WINDOW) {
      handHistoryRef.current.shift();
    }
    const avg =
      handHistoryRef.current.reduce((a, b) => a + b, 0) /
      handHistoryRef.current.length;
    return avg;
  };

  // Main detection loop
  useEffect(() => {
    if (!isInitialized) return;

    let running = true;

    const detectHands = () => {
      if (!running) return;

      if (
        !videoRef.current ||
        !canvasRef.current ||
        !handLandmarkerRef.current ||
        videoRef.current.readyState !== videoRef.current.HAVE_ENOUGH_DATA
      ) {
        animationFrameRef.current = requestAnimationFrame(detectHands);
        return;
      }

      try {
        const results = handLandmarkerRef.current.detectForVideo(
          videoRef.current,
          performance.now()
        );

        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d')!;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw video frame
        ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

        // Track hand position (using wrist landmark index 0)
        if (results.landmarks && results.landmarks.length > 0) {
          // Get the first detected hand's wrist position (landmark 0 is wrist)
          const hand = results.landmarks[0];
          const wrist = hand[0]; // Wrist landmark
          
          // Use raw Y coordinate (0 = top, 1 = bottom)
          const handY = wrist.y;
          
          const smoothedHeight = getSmoothedHandHeight(handY);
          handHeightRef.current = 1 - smoothedHeight; // Invert for gauge (1 = top, 0 = bottom)

          // Simple directional tracking
          if (lastHandYRef.current !== null) {
            const deltaY = handY - lastHandYRef.current;
            
            // Moving up (Y decreasing, going toward top of screen)
            if (deltaY < -MOVEMENT_THRESHOLD) {
              if (stateRef.current === 'idle' || stateRef.current === 'moving_down') {
                stateRef.current = 'moving_up';
              }
            }
            // Moving down (Y increasing, going toward bottom of screen)
            else if (deltaY > MOVEMENT_THRESHOLD) {
              if (stateRef.current === 'moving_up') {
                // Completed a full cycle: up then down
                setRepCount((prev) => prev + 1);
                playPopSound();
                stateRef.current = 'moving_down';
              } else if (stateRef.current === 'idle') {
                stateRef.current = 'moving_down';
              }
            }
          }
          
          lastHandYRef.current = handY;

          // Draw hand landmarks
          ctx.fillStyle = '#00f5ff';
          for (const landmark of hand) {
            ctx.beginPath();
            ctx.arc(
              landmark.x * canvas.width,
              landmark.y * canvas.height,
              5,
              0,
              2 * Math.PI
            );
            ctx.fill();
          }
        }
      } catch (err) {
        console.error('Detection error:', err);
      }

      animationFrameRef.current = requestAnimationFrame(detectHands);
    };

    animationFrameRef.current = requestAnimationFrame(detectHands);

    return () => {
      running = false;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [isInitialized]);

  const resetCount = () => {
    setRepCount(0);
    stateRef.current = 'idle';
    handHistoryRef.current = [];
    lastHandYRef.current = null;
  };

  return (
    <div className="flex min-h-screen w-full bg-black text-white flex-col items-center justify-center p-4">
      {/* Header */}
      <div className="mb-8 text-center">
        <h1 className="text-5xl md:text-6xl font-bold neon-text mb-2">
          REP COUNTER
        </h1>
        <p className="text-gray-400 text-lg">Track your reps with AI-powered pose detection</p>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-900 border border-red-500 rounded-lg text-red-200">
          {error}
        </div>
      )}

      <div className="w-full max-w-5xl flex flex-col md:flex-row gap-6 items-start justify-center">
        {/* Video & Gauge Container */}
        <div className="flex-1 flex gap-4 justify-center">
          {/* Gauge */}
          <div className="w-12 h-96 bg-gray-900 rounded-full border-2 border-cyan-500 neon-border flex flex-col-reverse overflow-hidden">
            <div
              className="w-full bg-gradient-to-t from-green-500 to-cyan-400 gauge-glow transition-all duration-100"
              style={{
                height: `${handHeightRef.current * 100}%`,
              }}
            />
          </div>

          {/* Video Feed */}
          <div className="relative">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              className="hidden"
              width={640}
              height={480}
            />
            <canvas
              ref={canvasRef}
              width={640}
              height={480}
              className="w-full max-w-md h-auto rounded-lg border-2 border-cyan-500 neon-border shadow-lg"
            />
          </div>
        </div>

        {/* Counter & Controls */}
        <div className="flex flex-col items-center gap-8 md:w-48">
          {/* Counter Display */}
          <div className="w-full">
            <div className="p-8 rounded-lg border-2 border-pink-500 bg-gray-950 neon-border text-center">
              <p className="text-gray-400 text-sm uppercase tracking-widest mb-2">
                Reps Completed
              </p>
              <p className="text-7xl font-bold neon-text">{repCount}</p>
            </div>
          </div>

          {/* Status Display */}
          <div className="w-full text-center">
            <p className="text-sm text-gray-500 uppercase tracking-widest">
              State: <span className="text-cyan-400 font-bold">{stateRef.current}</span>
            </p>
          </div>

          {/* Reset Button */}
          <button
            onClick={resetCount}
            className="w-full px-6 py-3 bg-gradient-to-r from-pink-600 to-cyan-600 hover:from-pink-500 hover:to-cyan-500 text-white font-bold rounded-lg transition-all duration-200 uppercase tracking-wider neon-border"
          >
            Reset
          </button>

          {/* Info Box */}
          <div className="w-full p-4 bg-gray-900 rounded-lg border border-gray-700 text-xs text-gray-400 text-center">
            <p className="mb-2">✋ Move hand UP then DOWN</p>
            <p>Each cycle counts as one rep</p>
          </div>
        </div>
      </div>

      {!isInitialized && (
        <div className="mt-8 text-center text-cyan-400 animate-pulse">
          Initializing pose detection...
        </div>
      )}
    </div>
  );
}
