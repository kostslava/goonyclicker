'use client';

import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

const MOVEMENT_THRESHOLD = 0.02;
const DEFAULT_TIME_LIMIT = 120;
const GRAVITY = 0.5;
const FLAP_STRENGTH = -10;
const PIPE_SPEED = 3;
const PIPE_GAP = 150;
const PIPE_WIDTH = 60;

interface Player {
  id: string;
  name: string;
  score: number;
}

interface Pipe {
  x: number;
  topHeight: number;
  passed: boolean;
}

export default function MultiplayerRace() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [gameState, setGameState] = useState<'menu' | 'lobby' | 'racing' | 'winner'>('menu');
  const [playerName, setPlayerName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [myPlayerId, setMyPlayerId] = useState('');
  const [players, setPlayers] = useState<Player[]>([]);
  const [myScore, setMyScore] = useState(0);
  const [opponentScore, setOpponentScore] = useState(0);
  const [error, setError] = useState('');
  const [winner, setWinner] = useState<Player | null>(null);
  const [isTracking, setIsTracking] = useState(false);
  const [timeLimit, setTimeLimit] = useState(DEFAULT_TIME_LIMIT);
  const [timeRemaining, setTimeRemaining] = useState(DEFAULT_TIME_LIMIT);
  
  const gameCanvasRef = useRef<HTMLCanvasElement>(null);
  const webcamCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const handLandmarkerRef = useRef<any>(null);
  const lastHandYRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const roomCodeRef = useRef<string>('');
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Game state refs
  const birdYRef = useRef(250);
  const birdVelocityRef = useRef(0);
  const pipesRef = useRef<Pipe[]>([]);
  const gameOverRef = useRef(false);
  const frameCountRef = useRef(0);

  // Init Socket.io
  useEffect(() => {
    const newSocket = io(window.location.origin, { transports: ['polling'] });
    
    newSocket.on('connect', () => {
      console.log('Socket connected:', newSocket.id);
      setSocket(newSocket);
      socketRef.current = newSocket;
    });

    newSocket.on('room-created', ({ roomCode, playerId }) => {
      console.log('Room created:', roomCode, 'Player ID:', playerId);
      setRoomCode(roomCode);
      roomCodeRef.current = roomCode;
      setMyPlayerId(playerId);
      setGameState('lobby');
    });

    newSocket.on('player-joined', ({ players, roomCode: joinedRoomCode }) => {
      console.log('Player joined room:', joinedRoomCode, 'Players:', players);
      setPlayers(players);
      setRoomCode(joinedRoomCode);
      roomCodeRef.current = joinedRoomCode;
      setGameState('lobby');
    });

    newSocket.on('game-start', ({ players, timeLimit }) => {
      console.log('Game starting! Players:', players, 'Time limit:', timeLimit);
      setPlayers(players);
      setGameState('racing');
      setTimeLimit(timeLimit || DEFAULT_TIME_LIMIT);
      setTimeRemaining(timeLimit || DEFAULT_TIME_LIMIT);
      
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = setInterval(() => {
        setTimeRemaining(prev => {
          if (prev <= 1) {
            if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
            setTimeout(() => {
              socketRef.current?.emit('game-over', { roomCode: roomCodeRef.current });
            }, 100);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      
      setTimeout(() => initHandTracking(), 500);
    });

    newSocket.on('score-update', ({ players }) => {
      setPlayers(players);
      const opponent = players.find((p: Player) => p.id !== myPlayerId);
      if (opponent) setOpponentScore(opponent.score);
    });

    newSocket.on('game-over', ({ winner }) => {
      console.log('Game over! Winner:', winner);
      setWinner(winner);
      setGameState('winner');
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    });

    newSocket.on('error', (msg) => {
      console.error('Socket error:', msg);
      setError(msg);
    });

    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      newSocket.close();
    };
  }, [myPlayerId]);

  const initHandTracking = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } 
      });
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await new Promise((resolve) => {
          if (videoRef.current) {
            videoRef.current.onloadedmetadata = () => {
              videoRef.current?.play();
              resolve(null);
            };
          }
        });
      }
      
      const mediapipe = await import('@mediapipe/tasks-vision');
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
      
      handLandmarkerRef.current = landmarker;
      setIsTracking(true);
      startGame();
    } catch (err: any) {
      setError(err.name === 'NotAllowedError' ? 'Camera permission denied' : 'Camera error: ' + err.message);
    }
  };

  const startGame = () => {
    birdYRef.current = 250;
    birdVelocityRef.current = 0;
    pipesRef.current = [];
    gameOverRef.current = false;
    frameCountRef.current = 0;
    setMyScore(0);
    
    const gameLoop = () => {
      if (gameState !== 'racing') return;
      
      updateGame();
      drawGame();
      drawWebcam();
      
      animationFrameRef.current = requestAnimationFrame(gameLoop);
    };
    
    gameLoop();
  };

  const updateGame = () => {
    if (gameOverRef.current) return;
    
    // Hand detection
    if (
      videoRef.current &&
      handLandmarkerRef.current &&
      videoRef.current.readyState === videoRef.current.HAVE_ENOUGH_DATA
    ) {
      const results = handLandmarkerRef.current.detectForVideo(videoRef.current, performance.now());
      
      if (results?.landmarks?.length > 0) {
        const hand = results.landmarks[0];
        const wrist = hand[0];
        const handY = wrist.y;
        
        if (lastHandYRef.current !== null) {
          const deltaY = handY - lastHandYRef.current;
          
          // Hand moved up = flap
          if (deltaY < -MOVEMENT_THRESHOLD) {
            birdVelocityRef.current = FLAP_STRENGTH;
          }
        }
        
        lastHandYRef.current = handY;
      }
    }
    
    // Bird physics
    birdVelocityRef.current += GRAVITY;
    birdYRef.current += birdVelocityRef.current;
    
    // Bounds check
    if (birdYRef.current > 500 || birdYRef.current < 0) {
      gameOverRef.current = true;
      return;
    }
    
    // Pipe generation
    frameCountRef.current++;
    if (frameCountRef.current % 90 === 0) {
      const topHeight = Math.random() * 200 + 50;
      pipesRef.current.push({ x: 800, topHeight, passed: false });
    }
    
    // Update pipes
    for (let i = pipesRef.current.length - 1; i >= 0; i--) {
      const pipe = pipesRef.current[i];
      pipe.x -= PIPE_SPEED;
      
      // Score check
      if (!pipe.passed && pipe.x + PIPE_WIDTH < 100) {
        pipe.passed = true;
        const newScore = myScore + 1;
        setMyScore(newScore);
        
        if (socketRef.current && roomCodeRef.current) {
          socketRef.current.emit('update-score', { 
            roomCode: roomCodeRef.current, 
            score: newScore 
          });
        }
      }
      
      // Collision check
      if (pipe.x < 150 && pipe.x + PIPE_WIDTH > 50) {
        if (birdYRef.current < pipe.topHeight || birdYRef.current > pipe.topHeight + PIPE_GAP) {
          gameOverRef.current = true;
        }
      }
      
      // Remove off-screen pipes
      if (pipe.x < -PIPE_WIDTH) {
        pipesRef.current.splice(i, 1);
      }
    }
  };

  const drawGame = () => {
    const canvas = gameCanvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Sky gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, 600);
    gradient.addColorStop(0, '#4a90e2');
    gradient.addColorStop(1, '#87CEEB');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 800, 600);
    
    // Pipes
    ctx.fillStyle = '#2ecc71';
    ctx.strokeStyle = '#27ae60';
    ctx.lineWidth = 3;
    
    pipesRef.current.forEach(pipe => {
      // Top pipe
      ctx.fillRect(pipe.x, 0, PIPE_WIDTH, pipe.topHeight);
      ctx.strokeRect(pipe.x, 0, PIPE_WIDTH, pipe.topHeight);
      
      // Bottom pipe
      const bottomY = pipe.topHeight + PIPE_GAP;
      ctx.fillRect(pipe.x, bottomY, PIPE_WIDTH, 600 - bottomY);
      ctx.strokeRect(pipe.x, bottomY, PIPE_WIDTH, 600 - bottomY);
    });
    
    // Bird
    ctx.fillStyle = '#FFD700';
    ctx.strokeStyle = '#FFA500';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(100, birdYRef.current, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    
    // Eye
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(110, birdYRef.current - 5, 3, 0, Math.PI * 2);
    ctx.fill();
    
    // Scores
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 4;
    ctx.font = 'bold 32px Arial';
    ctx.strokeText(`You: ${myScore}`, 20, 40);
    ctx.fillText(`You: ${myScore}`, 20, 40);
    
    ctx.font = 'bold 24px Arial';
    ctx.strokeText(`Opponent: ${opponentScore}`, 20, 80);
    ctx.fillText(`Opponent: ${opponentScore}`, 20, 80);
    
    // Game over
    if (gameOverRef.current) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(0, 0, 800, 600);
      
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 48px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('GAME OVER', 400, 280);
      ctx.font = 'bold 24px Arial';
      ctx.fillText(`Final Score: ${myScore}`, 400, 330);
      ctx.textAlign = 'left';
    }
  };

  const drawWebcam = () => {
    const canvas = webcamCanvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || video.readyState !== video.HAVE_ENOUGH_DATA) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Draw mirrored video
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
    ctx.restore();
    
    // Draw hand landmarks
    if (handLandmarkerRef.current && video.readyState === video.HAVE_ENOUGH_DATA) {
      const results = handLandmarkerRef.current.detectForVideo(video, performance.now());
      
      if (results?.landmarks?.length > 0) {
        const hand = results.landmarks[0];
        
        ctx.fillStyle = '#00f5ff';
        ctx.strokeStyle = '#00f5ff';
        ctx.lineWidth = 2;
        
        hand.forEach((landmark: any) => {
          ctx.beginPath();
          ctx.arc(
            canvas.width - landmark.x * canvas.width,
            landmark.y * canvas.height,
            4,
            0,
            2 * Math.PI
          );
          ctx.fill();
        });
      }
    }
  };

  const createRoom = () => {
    if (!playerName.trim()) {
      setError('Please enter your name');
      return;
    }
    if (!socketRef.current || !socketRef.current.connected) {
      setError('Connecting to server...');
      return;
    }
    console.log('Creating room with name:', playerName, 'timeLimit:', timeLimit);
    setError('');
    socketRef.current.emit('create-room', { playerName, timeLimit });
  };

  const joinRoom = () => {
    if (!playerName.trim() || !roomCode.trim()) {
      setError('Please enter name and room code');
      return;
    }
    if (!socketRef.current || !socketRef.current.connected) {
      setError('Connecting to server...');
      return;
    }
    const upperRoomCode = roomCode.toUpperCase();
    console.log('Joining room:', upperRoomCode, 'with name:', playerName);
    setError('');
    roomCodeRef.current = upperRoomCode;
    socketRef.current.emit('join-room', { roomCode: upperRoomCode, playerName });
  };

  if (gameState === 'menu') {
    return (
      <div className="flex min-h-screen w-full bg-black text-white flex-col items-center justify-center p-4">
        <h1 className="text-6xl font-bold mb-4" style={{ textShadow: '0 0 20px #00f5ff' }}>
          FLAPPY GOON
        </h1>
        <p className="text-xl text-gray-400 mb-12">Move your hand up to flap!</p>
        
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
              className="w-full px-4 py-3 bg-gray-900 border-2 border-cyan-500 rounded-lg text-white focus:outline-none"
            >
              <option value={60}>1 Minute</option>
              <option value={120}>2 Minutes</option>
              <option value={180}>3 Minutes</option>
              <option value={300}>5 Minutes</option>
            </select>
          </div>
          
          <button
            onClick={createRoom}
            className="w-full px-6 py-4 bg-gradient-to-r from-cyan-600 to-pink-600 hover:from-cyan-500 hover:to-pink-500 text-white font-bold rounded-lg transition-all uppercase"
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
              className="flex-1 px-4 py-3 bg-gray-900 border-2 border-cyan-500 rounded-lg text-white uppercase focus:outline-none"
            />
            <button
              onClick={joinRoom}
              className="px-6 py-3 bg-gradient-to-r from-pink-600 to-cyan-600 hover:from-pink-500 hover:to-cyan-500 text-white font-bold rounded-lg transition-all uppercase"
            >
              Join
            </button>
          </div>
          
          {error && <p className="text-red-500 text-center">{error}</p>}
        </div>
      </div>
    );
  }

  if (gameState === 'lobby') {
    return (
      <div className="flex min-h-screen w-full bg-black text-white flex-col items-center justify-center p-4">
        <h1 className="text-5xl font-bold mb-8" style={{ textShadow: '0 0 20px #00f5ff' }}>
          WAITING ROOM
        </h1>
        
        <div className="max-w-md w-full p-8 bg-gray-900 rounded-lg border-2 border-cyan-500">
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
        <h1 className="text-7xl font-bold mb-8 animate-pulse">
          {winner?.id === myPlayerId ? '🏆 YOU WIN! 🏆' : '😢 YOU LOSE 😢'}
        </h1>
        <p className="text-4xl mb-4">{winner?.name} won with {winner?.score} points!</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-8 px-8 py-4 bg-gradient-to-r from-cyan-600 to-pink-600 hover:from-cyan-500 hover:to-pink-500 text-white font-bold rounded-lg transition-all uppercase text-2xl"
        >
          Play Again
        </button>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen w-full bg-black flex items-center justify-center">
      <video ref={videoRef} autoPlay playsInline className="hidden" />
      
      {/* Game Canvas */}
      <canvas
        ref={gameCanvasRef}
        width={800}
        height={600}
        className="border-4 border-cyan-500"
        style={{ boxShadow: '0 0 30px rgba(0, 245, 255, 0.5)' }}
      />
      
      {/* Webcam Corner View */}
      <div className="absolute top-4 right-4 z-50">
        <div className="border-4 border-pink-500 rounded-lg overflow-hidden" style={{ boxShadow: '0 0 20px rgba(255, 105, 180, 0.5)' }}>
          <canvas ref={webcamCanvasRef} width={240} height={180} />
        </div>
        <p className="text-center text-white mt-2 text-sm font-bold">Your Camera</p>
      </div>
      
      {/* Timer */}
      <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-black bg-opacity-70 px-6 py-3 rounded-lg border-2 border-cyan-500">
        <p className="text-4xl font-bold text-cyan-400">
          {Math.floor(timeRemaining / 60)}:{(timeRemaining % 60).toString().padStart(2, '0')}
        </p>
      </div>
      
      {!isTracking && (
        <div className="absolute inset-0 bg-black bg-opacity-90 flex flex-col items-center justify-center z-50">
          <p className="text-white text-2xl mb-4">{error || 'Initializing camera...'}</p>
          {error && (
            <button
              onClick={() => {
                setError('');
                initHandTracking();
              }}
              className="px-6 py-3 bg-pink-600 hover:bg-pink-500 text-white font-bold rounded-lg"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
