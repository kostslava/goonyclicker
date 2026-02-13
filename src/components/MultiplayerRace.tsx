'use client';

import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

const MOVEMENT_THRESHOLD = 0.02;
const DEFAULT_TIME_LIMIT = 120; // 2 minutes in seconds

interface Player {
  id: string;
  name: string;
  score: number;
  position: number;
  multiplier?: number;
  currency?: number;
}

interface Upgrade {
  id: string;
  name: string;
  description: string;
  cost: number;
  multiplier: number;
  image?: string;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
}

const UPGRADES: Upgrade[] = [
  { id: 'lebron', name: '👑 Lebron Poster', description: '+1 goon per stroke', cost: 10, multiplier: 1, image: 'https://a.espncdn.com/i/headshots/nba/players/full/1966.png' },
  { id: 'lotion', name: '🧴 Premium Lotion', description: '+2 goons per stroke', cost: 50, multiplier: 2 },
  { id: 'vr', name: '🥽 VR Headset', description: '+5 goons per stroke', cost: 200, multiplier: 5 },
  { id: 'ai', name: '🤖 AI Girlfriend', description: '+10 goons per stroke', cost: 500, multiplier: 10 },
  { id: 'lab', name: '🧪 Gene Therapy', description: '+25 goons per stroke', cost: 2000, multiplier: 25 },
];

export default function MultiplayerRace() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [gameState, setGameState] = useState<'menu' | 'lobby' | 'racing' | 'winner'>('menu');
  const [playerName, setPlayerName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [myPlayerId, setMyPlayerId] = useState('');
  const [players, setPlayers] = useState<Player[]>([]);
  const [localScore, setLocalScore] = useState(0);
  const [currency, setCurrency] = useState(0);
  const [multiplier, setMultiplier] = useState(1);
  const [ownedUpgrades, setOwnedUpgrades] = useState<string[]>([]);
  const [showShop, setShowShop] = useState(false);
  const [error, setError] = useState('');
  const [winner, setWinner] = useState<Player | null>(null);
  const [isTracking, setIsTracking] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [particles, setParticles] = useState<Particle[]>([]);
  const [timeLimit, setTimeLimit] = useState(DEFAULT_TIME_LIMIT);
  const [timeRemaining, setTimeRemaining] = useState(DEFAULT_TIME_LIMIT);
  const [gameStartTime, setGameStartTime] = useState<number | null>(null);
  const [streak, setStreak] = useState(0);
  const [comboMultiplier, setComboMultiplier] = useState(1);
  const [opponentStream, setOpponentStream] = useState<MediaStream | null>(null);
  
  const webcamCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const opponentVideoRef = useRef<HTMLVideoElement>(null);
  const handLandmarkerRef = useRef<any>(null);
  const lastHandYRef = useRef<number | null>(null);
  const stateRef = useRef<'idle' | 'moving_up' | 'moving_down'>('idle');
  const animationFrameRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const roomCodeRef = useRef<string>('');
  const lastStrokeTimeRef = useRef<number>(0);
  const particlesRef = useRef<Particle[]>([]);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const streakTimerRef = useRef<NodeJS.Timeout | null>(null);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize Socket.io (only once)
  useEffect(() => {
    console.log('Connecting to server at:', window.location.origin);
    const newSocket = io(window.location.origin, {
      transports: ['websocket', 'polling']
    });
    
    newSocket.on('connect', () => {
      console.log('Socket connected!', newSocket.id);
      socketRef.current = newSocket;
    });
    
    newSocket.on('connect_error', (error) => {
      console.error('Socket connection error:', error);
      setError('Failed to connect to server');
    });
    
    setSocket(newSocket);
    socketRef.current = newSocket;

    newSocket.on('room-created', ({ roomCode, playerId }) => {
      console.log('Room created:', roomCode);
      setRoomCode(roomCode);
      roomCodeRef.current = roomCode;
      setMyPlayerId(playerId);
      setGameState('lobby');
    });

    newSocket.on('player-joined', ({ players }) => {
      console.log('Player joined, total players:', players.length);
      setPlayers(players);
    });

    newSocket.on('game-start', ({ players, timeLimit }) => {
      console.log('Game starting with players:', players, 'Time limit:', timeLimit);
      setPlayers(players);
      setGameState('racing');
      setTimeLimit(timeLimit || DEFAULT_TIME_LIMIT);
      setTimeRemaining(timeLimit || DEFAULT_TIME_LIMIT);
      setGameStartTime(Date.now());
      
      // Start countdown timer
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = setInterval(() => {
        setTimeRemaining(prev => {
          if (prev <= 1) {
            if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
            // Game over - find winner
            setTimeout(() => {
              socketRef.current?.emit('game-over', { roomCode: roomCodeRef.current });
            }, 100);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      
      // Don't auto-init on mobile, let user click button
      if (!cameraReady) {
        setTimeout(() => {
          initHandTracking().then(() => {
            // Start WebRTC video chat after camera is ready
            setTimeout(() => startVideoChat(newSocket), 1000);
          });
        }, 500);
      } else {
        // Camera already ready, just start video chat
        setTimeout(() => startVideoChat(newSocket), 1000);
      }
    });

    newSocket.on('score-update', ({ players }) => {
      console.log('Score update received:', players);
      setPlayers(players);
    });

    newSocket.on('game-over', ({ winner }) => {
      console.log('Game over! Winner:', winner);
      setWinner(winner);
      setGameState('winner');
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      if (peerConnectionRef.current) peerConnectionRef.current.close();
      playWinSound();
    });

    // WebRTC signaling for video chat
    newSocket.on('webrtc-offer', async ({ offer, from }) => {
      console.log('Received WebRTC offer from:', from);
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });
      peerConnectionRef.current = pc;

      pc.ontrack = (event) => {
        console.log('Received remote stream');
        setOpponentStream(event.streams[0]);
        if (opponentVideoRef.current) {
          opponentVideoRef.current.srcObject = event.streams[0];
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          newSocket.emit('webrtc-ice', { candidate: event.candidate, to: from });
        }
      };

      if (videoRef.current && videoRef.current.srcObject) {
        (videoRef.current.srcObject as MediaStream).getTracks().forEach(track => {
          pc.addTrack(track, videoRef.current!.srcObject as MediaStream);
        });
      }

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      newSocket.emit('webrtc-answer', { answer, to: from });
    });

    newSocket.on('webrtc-answer', async ({ answer }) => {
      console.log('Received WebRTC answer');
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));
      }
    });

    newSocket.on('webrtc-ice', async ({ candidate }) => {
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    newSocket.on('error', (msg) => {
      console.error('Server error:', msg);
      setError(msg);
    });

    return () => {
      console.log('Closing socket connection');
      if (peerConnectionRef.current) peerConnectionRef.current.close();
      newSocket.close();
    };
  }, []); // Remove gameState from dependencies!

  // Play rep sound
  const playRepSound = (pitch = 1) => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const ctx = audioContextRef.current;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(300 * pitch, now);
    osc.frequency.exponentialRampToValueAtTime(600 * pitch, now + 0.1);
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
    osc.start(now);
    osc.stop(now + 0.1);
  };

  // Play win sound
  const playWinSound = () => {
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
    osc.frequency.exponentialRampToValueAtTime(1200, now + 0.3);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    osc.start(now);
    osc.stop(now + 0.3);
  };

  // Start video chat via WebRTC
  const startVideoChat = async (socket: Socket) => {
    try {
      if (!videoRef.current || !videoRef.current.srcObject) {
        console.log('Video not ready yet for WebRTC');
        return;
      }

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });
      peerConnectionRef.current = pc;

      // Add local video tracks
      (videoRef.current.srcObject as MediaStream).getTracks().forEach(track => {
        pc.addTrack(track, videoRef.current!.srcObject as MediaStream);
      });

      // Handle incoming tracks
      pc.ontrack = (event) => {
        console.log('Received opponent video stream');
        setOpponentStream(event.streams[0]);
        if (opponentVideoRef.current) {
          opponentVideoRef.current.srcObject = event.streams[0];
        }
      };

      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('webrtc-ice', { 
            candidate: event.candidate, 
            roomCode: roomCodeRef.current 
          });
        }
      };

      // Create and send offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('webrtc-offer', { 
        offer, 
        roomCode: roomCodeRef.current 
      });
      console.log('Sent WebRTC offer');
    } catch (err) {
      console.error('Failed to start video chat:', err);
    }
  };

  // Spawn particles (white liquid)
  const spawnParticles = (x: number, y: number, count: number, speed: number) => {
    const newParticles: Particle[] = [];
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2; // Full circle
      const velocity = (Math.random() * 2 + 1) * speed;
      newParticles.push({
        x,
        y,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity - 1, // Slight upward bias
        life: 1.0,
        size: Math.random() * 8 + 3
      });
    }
    particlesRef.current.push(...newParticles);
  };

  // Buy upgrade
  const buyUpgrade = (upgrade: Upgrade) => {
    if (currency >= upgrade.cost && !ownedUpgrades.includes(upgrade.id)) {
      setCurrency(prev => prev - upgrade.cost);
      setMultiplier(prev => prev + upgrade.multiplier);
      setOwnedUpgrades(prev => [...prev, upgrade.id]);
      
      // Emit upgrade to server
      if (socketRef.current && roomCodeRef.current) {
        socketRef.current.emit('update-multiplier', { 
          roomCode: roomCodeRef.current, 
          multiplier: multiplier + upgrade.multiplier 
        });
      }
    }
  };

  // Initialize hand tracking
  const initHandTracking = async () => {
    try {
      console.log('Initializing hand tracking...');
      
      // Check if getUserMedia is supported
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera not supported on this browser. Use Chrome/Safari.');
      }
      
      // Request camera first (better for mobile)
      console.log('Requesting camera access...');
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 }
        } 
      });
      console.log('Camera access granted!');
      
      if (!videoRef.current) {
        throw new Error('Video element not found');
      }
      
      videoRef.current.srcObject = stream;
      await new Promise((resolve) => {
        if (videoRef.current) {
          videoRef.current.onloadedmetadata = () => {
            console.log('Video metadata loaded');
            if (videoRef.current) {
              videoRef.current.play().catch(e => console.error('Play error:', e));
            }
            resolve(null);
          };
        }
      });
      
      console.log('Loading MediaPipe...');
      const mediapipe = await import('@mediapipe/tasks-vision');
      if (!mediapipe || !mediapipe.HandLandmarker || !mediapipe.FilesetResolver) {
        throw new Error('Failed to load MediaPipe library');
      }
      
      const { HandLandmarker, FilesetResolver } = mediapipe;
      
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm'
      );
      
      const landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
        },
        runningMode: 'VIDEO',
        numHands: 1,
      });
      
      if (!landmarker) {
        throw new Error('Failed to create HandLandmarker');
      }
      
      handLandmarkerRef.current = landmarker;
      console.log('HandLandmarker initialized, starting detection');
      setCameraReady(true);
      setIsTracking(true);
      startDetection();
    } catch (err: any) {
      console.error('Failed to init hand tracking:', err);
      console.error('Error stack:', err?.stack);
      if (err.name === 'NotAllowedError') {
        setError('Camera permission denied. Please allow camera access and refresh.');
      } else if (err.name === 'NotFoundError') {
        setError('No camera found. Please check your device.');
      } else if (err.name === 'NotSupportedError' || err.name === 'TypeError') {
        setError('Camera requires HTTPS. See console for link.');
        console.error('*************************************');
        console.error('MOBILE USERS: Camera requires HTTPS!');
        console.error('Use this tool to create a public URL:');
        console.error('Run: npx localtunnel --port 3000');
        console.error('Or install ngrok and run: ngrok http 3000');
        console.error('*************************************');
      } else {
        setError(`Error: ${err?.message || String(err)}`);
      }
    }
  };

  // Hand detection loop
  const startDetection = () => {
    let running = true;

    const detectHands = () => {
      if (!running || gameState === 'winner') return;

      if (
        !videoRef.current ||
        !webcamCanvasRef.current ||
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

        // Draw webcam feed with hand landmarks
        const canvas = webcamCanvasRef.current;
        if (!canvas) {
          animationFrameRef.current = requestAnimationFrame(detectHands);
          return;
        }
        
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          animationFrameRef.current = requestAnimationFrame(detectHands);
          return;
        }
        
        // Get video dimensions
        const videoWidth = videoRef.current.videoWidth;
        const videoHeight = videoRef.current.videoHeight;
        const canvasWidth = canvas.width;
        const canvasHeight = canvas.height;
        
        // Calculate aspect ratio fit
        const videoAspect = videoWidth / videoHeight;
        const canvasAspect = canvasWidth / canvasHeight;
        
        let drawWidth, drawHeight, offsetX, offsetY;
        
        if (videoAspect > canvasAspect) {
          // Video is wider - fit to height
          drawHeight = canvasHeight;
          drawWidth = canvasHeight * videoAspect;
          offsetX = (canvasWidth - drawWidth) / 2;
          offsetY = 0;
        } else {
          // Video is taller - fit to width
          drawWidth = canvasWidth;
          drawHeight = canvasWidth / videoAspect;
          offsetX = 0;
          offsetY = (canvasHeight - drawHeight) / 2;
        }
        
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(
          videoRef.current,
          -offsetX - drawWidth,
          offsetY,
          drawWidth,
          drawHeight
        );
        ctx.restore();

        // Update and draw particles
        particlesRef.current = particlesRef.current.filter(p => {
          p.x += p.vx;
          p.y += p.vy;
          p.vy += 0.3; // Gravity
          p.life -= 0.02;
          
          if (p.life > 0) {
            ctx.fillStyle = `rgba(255, 255, 255, ${p.life})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
            return true;
          }
          return false;
        });

        if (results && results.landmarks && results.landmarks.length > 0) {
          const hand = results.landmarks[0];
          const wrist = hand[0];
          const handY = wrist.y;

          // Draw hand landmarks
          ctx.fillStyle = '#00f5ff';
          ctx.strokeStyle = '#00f5ff';
          ctx.lineWidth = 2;
          
          for (let i = 0; i < hand.length; i++) {
            const landmark = hand[i];
            ctx.beginPath();
            ctx.arc(
              canvas.width - landmark.x * canvas.width,
              landmark.y * canvas.height,
              5,
              0,
              2 * Math.PI
            );
            ctx.fill();
          }

          // Rep counting logic
          if (lastHandYRef.current !== null) {
            const deltaY = handY - lastHandYRef.current;
            
            if (deltaY < -MOVEMENT_THRESHOLD) {
              if (stateRef.current === 'idle' || stateRef.current === 'moving_down') {
                stateRef.current = 'moving_up';
                console.log('State: moving_up');
              }
            } else if (deltaY > MOVEMENT_THRESHOLD) {
              if (stateRef.current === 'moving_up') {
                // Calculate speed (time since last stroke)
                const now = performance.now();
                const timeSinceLastStroke = (now - lastStrokeTimeRef.current) / 1000;
                const speed = timeSinceLastStroke > 0 ? Math.min(3, 1 / timeSinceLastStroke) : 1;
                
                // Streak system - fast strokes build combo
                let newStreak = streak;
                let newCombo = comboMultiplier;
                if (timeSinceLastStroke < 0.8) {
                  newStreak++;
                  newCombo = Math.min(5, 1 + Math.floor(newStreak / 3) * 0.5);
                  setStreak(newStreak);
                  setComboMultiplier(newCombo);
                  
                  // Reset streak timer
                  if (streakTimerRef.current) clearTimeout(streakTimerRef.current);
                  streakTimerRef.current = setTimeout(() => {
                    setStreak(0);
                    setComboMultiplier(1);
                  }, 2000);
                } else {
                  newStreak = 0;
                  newCombo = 1;
                  setStreak(0);
                  setComboMultiplier(1);
                }
                
                lastStrokeTimeRef.current = now;

                // Play sound (pitch increases with combo)
                playRepSound(newCombo);

                setLocalScore((prevScore) => {
                  const newScore = prevScore + 1;
                  console.log('REP COUNTED! New score:', newScore, 'Combo:', newCombo);
                  
                  if (socketRef.current && roomCodeRef.current) {
                    console.log('Emitting score update:', { roomCode: roomCodeRef.current, score: newScore });
                    socketRef.current.emit('update-score', { roomCode: roomCodeRef.current, score: newScore });
                  } else {
                    console.error('Cannot emit score - socket:', !!socketRef.current, 'roomCode:', roomCodeRef.current);
                  }
                  
                  return newScore;
                });

                setCurrency((prev) => prev + multiplier * newCombo);

                // Spawn particles based on multiplier, speed, and combo
                const particleCount = Math.floor(multiplier * 3 + speed * 5 + newCombo * 5);
                const handX = canvas.width - wrist.x * canvas.width;
                const handYPos = wrist.y * canvas.height;
                spawnParticles(handX, handYPos, particleCount, speed);
                
                stateRef.current = 'moving_down';
                
                // Visual feedback with combo
                ctx.fillStyle = newCombo > 1 ? '#ffff00' : '#00ff00';
                ctx.font = 'bold 40px Arial';
                const text = newCombo > 1 ? `x${newCombo}!` : `+${multiplier}!`;
                ctx.fillText(text, canvas.width / 2 - 40, canvas.height / 2);
              } else if (stateRef.current === 'idle') {
                stateRef.current = 'moving_down';
                console.log('State: moving_down (from idle)');
              }
            }
          }
          
          lastHandYRef.current = handY;

          // Draw state indicator
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 16px Arial';
          ctx.fillText(`State: ${stateRef.current}`, 10, 30);
          ctx.fillText(`Score: ${localScore}`, 10, 55);
        } else {
          // No hand detected
          ctx.fillStyle = '#ff0000';
          ctx.font = 'bold 20px Arial';
          ctx.fillText('NO HAND DETECTED', 10, 30);
        }
      } catch (err) {
        console.error('Detection error:', err);
      }

      animationFrameRef.current = requestAnimationFrame(detectHands);
    };

    detectHands();
    
    return () => {
      running = false;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  };

  const createRoom = () => {
    if (!playerName.trim()) {
      setError('Please enter your name');
      return;
    }
    console.log('Creating room as:', playerName, 'Time limit:', timeLimit);
    setError(''); // Clear previous errors
    socket?.emit('create-room', { playerName, timeLimit });
  };

  const joinRoom = () => {
    if (!playerName.trim() || !roomCode.trim()) {
      setError('Please enter name and room code');
      return;
    }
    const upperRoomCode = roomCode.toUpperCase();
    console.log('Joining room:', upperRoomCode, 'as', playerName);
    setError(''); // Clear previous errors
    roomCodeRef.current = upperRoomCode;
    socket?.emit('join-room', { roomCode: upperRoomCode, playerName });
  };

  if (gameState === 'menu') {
    return (
      <div className="flex min-h-screen w-full bg-black text-white flex-col items-center justify-center p-4">
        <h1 className="text-6xl font-bold neon-text mb-4">GOON RACER</h1>
        <p className="text-xl text-gray-400 mb-12">Race against time!</p>
        
        <div className="max-w-md w-full space-y-6">
          <input
            type="text"
            placeholder="Enter your name"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            className="w-full px-4 py-3 bg-gray-900 border-2 border-cyan-500 rounded-lg text-white focus:outline-none focus:border-pink-500"
          />
          
          <div>
            <label className="block text-sm text-gray-400 mb-2">Time Limit</label>
            <select
              value={timeLimit}
              onChange={(e) => setTimeLimit(Number(e.target.value))}
              className="w-full px-4 py-3 bg-gray-900 border-2 border-cyan-500 rounded-lg text-white focus:outline-none focus:border-pink-500"
            >
              <option value={60}>1 Minute</option>
              <option value={120}>2 Minutes</option>
              <option value={180}>3 Minutes</option>
              <option value={300}>5 Minutes</option>
              <option value={600}>10 Minutes</option>
            </select>
          </div>
          
          <button
            onClick={createRoom}
            className="w-full px-6 py-4 bg-gradient-to-r from-cyan-600 to-pink-600 hover:from-cyan-500 hover:to-pink-500 text-white font-bold rounded-lg transition-all uppercase tracking-wider neon-border"
          >
            Create Room
          </button>
          
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Room Code"
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
              maxLength={6}
              className="flex-1 px-4 py-3 bg-gray-900 border-2 border-cyan-500 rounded-lg text-white uppercase focus:outline-none focus:border-pink-500"
            />
            <button
              onClick={joinRoom}
              className="px-6 py-3 bg-gradient-to-r from-pink-600 to-cyan-600 hover:from-pink-500 hover:to-cyan-500 text-white font-bold rounded-lg transition-all uppercase"
            >
              Join
            </button>
          </div>
          
          {error && (
            <p className="text-red-500 text-center">{error}</p>
          )}
        </div>
      </div>
    );
  }

  if (gameState === 'lobby') {
    return (
      <div className="flex min-h-screen w-full bg-black text-white flex-col items-center justify-center p-4">
        <h1 className="text-5xl font-bold neon-text mb-8">WAITING ROOM</h1>
        
        <div className="max-w-md w-full p-8 bg-gray-900 rounded-lg border-2 border-cyan-500 neon-border">
          <p className="text-center text-3xl font-bold mb-6">Room Code</p>
          <p className="text-center text-5xl font-mono text-cyan-400 mb-8">{roomCode}</p>
          
          <div className="space-y-4">
            {players.map((player, idx) => (
              <div key={player.id} className="p-4 bg-gray-800 rounded-lg">
                <p className="text-xl">Player {idx + 1}: {player.name}</p>
              </div>
            ))}
            
            {players.length < 2 && (
              <div className="p-4 bg-gray-800 rounded-lg border-2 border-dashed border-gray-600">
                <p className="text-xl text-gray-400">Waiting for opponent...</p>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (gameState === 'winner') {
    return (
      <div className="flex min-h-screen w-full bg-black text-white flex-col items-center justify-center p-4">
        <h1 className="text-7xl font-bold neon-text mb-8 animate-pulse">
          {winner?.id === myPlayerId ? '🏆 YOU WIN! 🏆' : '😢 YOU LOSE 😢'}
        </h1>
        <p className="text-4xl mb-4">{winner?.name} finished first with {winner?.score} reps!</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-8 px-8 py-4 bg-gradient-to-r from-cyan-600 to-pink-600 hover:from-cyan-500 hover:to-pink-500 text-white font-bold rounded-lg transition-all uppercase tracking-wider text-2xl"
        >
          Play Again
        </button>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen w-full bg-black text-white overflow-hidden">
      <video ref={videoRef} autoPlay playsInline className="hidden" />
      
      {/* Fullscreen Webcam Canvas */}
      <canvas
        ref={webcamCanvasRef}
        width={1280}
        height={720}
        className="absolute inset-0 w-full h-full object-contain bg-black"
      />
      
      {!isTracking && (
        <div className="absolute inset-0 bg-black bg-opacity-90 flex flex-col items-center justify-center p-4 z-50">
          <p className="text-white mb-4 text-center text-2xl">
            {error ? error : 'Initializing camera...'}
          </p>
          {error && (
            <button
              onClick={() => {
                setError('');
                initHandTracking();
              }}
              className="px-6 py-3 bg-pink-600 hover:bg-pink-500 text-white font-bold rounded-lg text-xl"
            >
              Retry Camera
            </button>
          )}
        </div>
      )}
      
      {/* Timer Display - Top Center */}
      <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-40">
        <div className="bg-black bg-opacity-70 px-8 py-4 rounded-lg border-4 border-cyan-500 neon-border">
          <p className="text-6xl font-bold text-cyan-400 tabular-nums">
            {Math.floor(timeRemaining / 60)}:{(timeRemaining % 60).toString().padStart(2, '0')}
          </p>
        </div>
      </div>
      
      {/* Stats - Top Left */}
      <div className="absolute top-4 left-4 z-40">
        <div className="bg-black bg-opacity-70 p-4 rounded-lg border-2 border-cyan-500 neon-border">
          <p className="text-2xl font-bold text-white">YOU</p>
          <p className="text-4xl font-bold text-cyan-400">💦 {currency}</p>
          <p className="text-xl text-pink-400">x{multiplier} per stroke</p>
          <p className="text-2xl text-white">Score: {localScore}</p>
          {comboMultiplier > 1 && (
            <p className="text-3xl font-bold text-yellow-400 animate-pulse">
              🔥 x{comboMultiplier} COMBO!
            </p>
          )}
        </div>
      </div>
      
      {/* Opponent Video Feed - Top Right */}
      <div className="absolute top-4 right-4 z-40">
        <div className="bg-black bg-opacity-70 p-2 rounded-lg border-2 border-pink-500 neon-border">
          <p className="text-xl font-bold text-white mb-1 text-center">
            {players.find(p => p.id !== myPlayerId)?.name || 'OPPONENT'}
          </p>
          <div className="relative w-48 h-36 bg-gray-900 rounded-lg overflow-hidden">
            <video
              ref={opponentVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover transform -scale-x-100"
            />
            {!opponentStream && (
              <div className="absolute inset-0 flex items-center justify-center text-gray-500">
                <p className="text-sm">Connecting...</p>
              </div>
            )}
          </div>
          <p className="text-xl text-white mt-1">Score: {players.find(p => p.id !== myPlayerId)?.score || 0}</p>
          <p className="text-sm text-pink-400">x{players.find(p => p.id !== myPlayerId)?.multiplier || 1} per stroke</p>
        </div>
      </div>
      
      {/* AR Upgrade Overlays - Bottom */}
      <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-40 flex gap-3">
        {UPGRADES.map(upgrade => {
          const owned = ownedUpgrades.includes(upgrade.id);
          const canAfford = currency >= upgrade.cost;
          
          return (
            <button
              key={upgrade.id}
              onClick={() => buyUpgrade(upgrade)}
              disabled={owned || !canAfford}
              className={`relative w-24 h-24 rounded-lg border-3 transition-all ${
                owned ? 'bg-green-500 bg-opacity-80 border-green-300' :
                canAfford ? 'bg-black bg-opacity-60 border-cyan-500 hover:scale-110' :
                'bg-black bg-opacity-40 border-gray-600 opacity-40'
              }`}
            >
              {upgrade.image ? (
                <img 
                  src={upgrade.image} 
                  alt={upgrade.name}
                  className={`w-full h-full object-cover rounded-lg ${owned ? '' : canAfford ? 'opacity-60' : 'opacity-20 grayscale'}`}
                />
              ) : (
                <span className="text-4xl">{upgrade.name.split(' ')[0]}</span>
              )}
              <div className="absolute -top-2 -right-2 bg-cyan-500 text-black text-xs font-bold px-2 py-1 rounded-full">
                {upgrade.cost}💦
              </div>
              {owned && (
                <div className="absolute inset-0 flex items-center justify-center bg-green-500 bg-opacity-50 rounded-lg">
                  <span className="text-4xl">✅</span>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
