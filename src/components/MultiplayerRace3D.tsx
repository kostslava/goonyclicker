'use client';

import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import * as THREE from 'three';

const MOVEMENT_THRESHOLD = 0.02;
const DEFAULT_TIME_LIMIT = 120;
const GRAVITY = -2.5;
const FLAP_STRENGTH = 10;
const PIPE_SPEED = 0.15;
const PIPE_GAP = 5.5;
const PIPE_WIDTH = 6;
const GROUND_LEVEL = -5;
const CEILING_LEVEL = 15;

interface Player {
  id: string;
  name: string;
  score: number;
}

interface Pipe {
  bottom: THREE.Mesh;
  top: THREE.Mesh;
  bottomCap: THREE.Mesh;
  topCap: THREE.Mesh;
  z: number;
  passed: boolean;
  gapY: number;
  width: number;
}

interface OpponentBird {
  mesh: THREE.Group;
  y: number;
  isAlive: boolean;
}

export default function MultiplayerRace3D() {
  const [gameState, setGameState] = useState<'menu' | 'lobby' | 'racing' | 'winner'>('menu');
  const [playerName, setPlayerName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [myPlayerId, setMyPlayerId] = useState('');
  const [players, setPlayers] = useState<Player[]>([]);
  const [myScore, setMyScore] = useState(0);
  const [error, setError] = useState('');
  const [winner, setWinner] = useState<Player | null>(null);
  const [isTracking, setIsTracking] = useState(false);
  const [timeLimit, setTimeLimit] = useState(DEFAULT_TIME_LIMIT);
  const [timeRemaining, setTimeRemaining] = useState(DEFAULT_TIME_LIMIT);
  const [isCreator, setIsCreator] = useState(false);
  const [alivePlayers, setAlivePlayers] = useState<Set<string>>(new Set());
  
  const containerRef = useRef<HTMLDivElement>(null);
  const webcamCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const handLandmarkerRef = useRef<{
    detectForVideo: (video: HTMLVideoElement, timestamp: number) => { landmarks?: unknown[][] };
  } | null>(null);
  const lastHandYRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const roomCodeRef = useRef<string>('');
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const repStateRef = useRef<'waiting' | 'up' | 'down'>('waiting');

  // Three.js refs
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const birdRef = useRef<THREE.Group | null>(null);
  const opponentBirdsRef = useRef<Map<string, OpponentBird>>(new Map());

  // Game state refs
  const birdYRef = useRef(0);
  const birdVelocityRef = useRef(0);
  const pipesRef = useRef<Pipe[]>([]);
  const gameOverRef = useRef(false);
  const frameCountRef = useRef(0);
  const isGameRunningRef = useRef(false);
  const lastObstacleZRef = useRef(-25);
  const spectatingRef = useRef(false);
  const spectateTargetsRef = useRef<string[]>([]);

  // Init Socket.io
  useEffect(() => {
    const newSocket = io(window.location.origin, { transports: ['polling'] });
    
    newSocket.on('connect', () => {
      console.log('Socket connected:', newSocket.id);
      socketRef.current = newSocket;
      setMyPlayerId(newSocket.id || '');
    });

    newSocket.on('room-created', ({ roomCode, playerId, players }) => {
      console.log('Room created:', roomCode, 'Player ID:', playerId);
      setRoomCode(roomCode);
      roomCodeRef.current = roomCode;
      setMyPlayerId(playerId);
      setPlayers(players || []);
      setIsCreator(true);
      setGameState('lobby');
    });

    newSocket.on('player-joined', ({ players, roomCode: joinedRoomCode, creator }) => {
      console.log('Player joined room:', joinedRoomCode, 'Players:', players);
      setPlayers(players);
      setRoomCode(joinedRoomCode);
      roomCodeRef.current = joinedRoomCode;
      setIsCreator(newSocket.id === creator);
      setGameState('lobby');
    });

    const initHandTrackingCallback = () => initHandTracking();

    newSocket.on('game-start', ({ players, timeLimit }) => {
      console.log('Game starting! Players:', players, 'Time limit:', timeLimit);
      setPlayers(players);
      setGameState('racing');
      setTimeLimit(timeLimit || DEFAULT_TIME_LIMIT);
      setTimeRemaining(timeLimit || DEFAULT_TIME_LIMIT);
      setAlivePlayers(new Set(players.map(p => p.id)));
      
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
      
      setTimeout(initHandTrackingCallback, 500);
    });

    newSocket.on('score-update', ({ players }) => {
      setPlayers(players);
    });

    newSocket.on('player-position', ({ playerId, y, isAlive }) => {
      const opponents = opponentBirdsRef.current;
      let opponent = opponents.get(playerId);
      
      if (!opponent && sceneRef.current) {
        // Create new opponent bird
        const bird = createBird(0x00ffff); // Different color for opponents
        sceneRef.current.add(bird);
        
        // Set initial horizontal position immediately
        const currentPlayers = players.length > 0 ? players : [];
        const opponentIndex = currentPlayers.findIndex(p => p.id === playerId);
        if (opponentIndex !== -1) {
          const spacing = 6;
          const totalWidth = (currentPlayers.length - 1) * spacing;
          const xOffset = opponentIndex * spacing - totalWidth / 2;
          bird.position.x = xOffset;
        }
        
        opponent = { mesh: bird, y, isAlive };
        opponents.set(playerId, opponent);
      }
      
      if (opponent) {
        opponent.y = y;
        opponent.isAlive = isAlive;
        opponent.mesh.visible = isAlive;
      }
    });

    newSocket.on('player-died', ({ playerId }) => {
      setAlivePlayers(prev => {
        const newAlive = new Set(prev);
        newAlive.delete(playerId);
        
        // Check if only one player left
        if (newAlive.size === 1) {
          const winnerId = Array.from(newAlive)[0];
          const winnerPlayer = players.find(p => p.id === winnerId);
          if (winnerPlayer) {
            // Award point to winner
            socketRef.current?.emit('update-score', { 
              roomCode: roomCodeRef.current, 
              score: winnerPlayer.score + 1 
            });
            
            // Restart game after a short delay
            setTimeout(() => {
              socketRef.current?.emit('restart-game', { roomCode: roomCodeRef.current });
            }, 2000);
          }
        }
        
        return newAlive;
      });
    });

    newSocket.on('game-restart', ({ players, timeLimit }) => {
      console.log('Game restarting! Players:', players);
      setPlayers(players);
      setGameState('racing');
      setTimeLimit(timeLimit || DEFAULT_TIME_LIMIT);
      setTimeRemaining(timeLimit || DEFAULT_TIME_LIMIT);
      setAlivePlayers(new Set(players.map(p => p.id)));
      setWinner(null);
      
      // Reset game state
      birdYRef.current = 0;
      birdVelocityRef.current = 0;
      pipesRef.current = [];
      gameOverRef.current = false;
      frameCountRef.current = 0;
      lastObstacleZRef.current = -25;
      isGameRunningRef.current = true;
      repStateRef.current = 'waiting';
      setMyScore(0);
      
      // Clear existing pipes from scene
      pipesRef.current.forEach(pipe => {
        sceneRef.current?.remove(pipe.bottom);
        sceneRef.current?.remove(pipe.top);
        sceneRef.current?.remove(pipe.bottomCap);
        sceneRef.current?.remove(pipe.topCap);
      });
      
      // Create new pipes
      for (let i = 0; i < 5; i++) {
        createObstacle(-25 - i * 25);
      }
      
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
    });

    newSocket.on('error', (msg) => {
      console.error('Socket error:', msg);
      setError(msg);
    });

    return () => {
      isGameRunningRef.current = false;
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      newSocket.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Three.js setup
  useEffect(() => {
    if (gameState !== 'racing' || !containerRef.current) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(75, 800 / 600, 0.1, 1000);
    camera.position.set(0, 2, 10);
    camera.lookAt(0, 0, -10);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: false }); // Disabled antialiasing for performance
    renderer.setSize(800, 600);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // Limit pixel ratio
    const container = containerRef.current;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.9);
    directionalLight.position.set(5, 10, 5);
    scene.add(directionalLight);

    // Create player bird
    const bird = createBird(0xFFD700);
    bird.position.set(0, 0, 0);
    scene.add(bird);
    birdRef.current = bird;

    // Create ground and ceiling indicators
    const groundGeometry = new THREE.PlaneGeometry(60, 250);
    const groundMaterial = new THREE.MeshPhongMaterial({ color: 0x7CFC00, side: THREE.DoubleSide });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = GROUND_LEVEL;
    scene.add(ground);

    return () => {
      if (rendererRef.current && container) {
        container.removeChild(rendererRef.current.domElement);
      }
      renderer.dispose();
    };
  }, [gameState]);

  const createBird = (color: number): THREE.Group => {
    const bird = new THREE.Group();
    
    // Body - further reduced segments for performance
    const bodyGeometry = new THREE.SphereGeometry(0.8, 12, 8);
    const bodyMaterial = new THREE.MeshPhongMaterial({ color });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    bird.add(body);
    
    // Wings
    const wingGeometry = new THREE.BoxGeometry(0.3, 0.1, 1);
    const wingMaterial = new THREE.MeshPhongMaterial({ color: color === 0xFFD700 ? 0xFFA500 : 0x00CED1 });
    
    const leftWing = new THREE.Mesh(wingGeometry, wingMaterial);
    leftWing.position.set(-0.7, 0, 0);
    bird.add(leftWing);
    
    const rightWing = new THREE.Mesh(wingGeometry, wingMaterial);
    rightWing.position.set(0.7, 0, 0);
    bird.add(rightWing);
    
    // Beak - reduced segments
    const beakGeometry = new THREE.ConeGeometry(0.2, 0.5, 4);
    const beakMaterial = new THREE.MeshPhongMaterial({ color: 0xFF6347 });
    const beak = new THREE.Mesh(beakGeometry, beakMaterial);
    beak.position.set(0, 0, 0.8);
    beak.rotation.x = Math.PI / 2;
    bird.add(beak);
    
    // Eyes - reduced segments
    const eyeGeometry = new THREE.SphereGeometry(0.15, 6, 4);
    const eyeMaterial = new THREE.MeshPhongMaterial({ color: 0x000000 });
    
    const leftEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    leftEye.position.set(0.3, 0.3, 0.6);
    bird.add(leftEye);
    
    const rightEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    rightEye.position.set(-0.3, 0.3, 0.6);
    bird.add(rightEye);
    
    return bird;
  };

  const createObstacle = (zPosition: number) => {
    if (!sceneRef.current) return;
    
    const gapPosition = GROUND_LEVEL + 2 + Math.random() * 5;
    
    // Calculate pipe width based on number of players
    const numPlayers = players.length || 1;
    const pipeWidth = Math.max(PIPE_WIDTH, numPlayers * 3 + 3);
    
    // Bottom pipe
    const bottomHeight = gapPosition - GROUND_LEVEL - PIPE_GAP / 2;
    const bottomGeometry = new THREE.BoxGeometry(pipeWidth, bottomHeight, pipeWidth);
    const pipeMaterial = new THREE.MeshPhongMaterial({ color: 0x228B22 });
    const bottomPipe = new THREE.Mesh(bottomGeometry, pipeMaterial);
    bottomPipe.position.set(0, GROUND_LEVEL + bottomHeight / 2, zPosition);
    sceneRef.current.add(bottomPipe);
    
    // Top pipe
    const topHeight = CEILING_LEVEL - gapPosition - PIPE_GAP / 2;
    const topGeometry = new THREE.BoxGeometry(pipeWidth, topHeight, pipeWidth);
    const topPipe = new THREE.Mesh(topGeometry, pipeMaterial);
    topPipe.position.set(0, gapPosition + PIPE_GAP / 2 + topHeight / 2, zPosition);
    sceneRef.current.add(topPipe);
    
    // Caps
    const capGeometry = new THREE.BoxGeometry(pipeWidth + 1, 0.5, pipeWidth + 1);
    const capMaterial = new THREE.MeshPhongMaterial({ color: 0x006400 });
    
    const bottomCap = new THREE.Mesh(capGeometry, capMaterial);
    bottomCap.position.set(0, gapPosition - PIPE_GAP / 2, zPosition);
    sceneRef.current.add(bottomCap);
    
    const topCap = new THREE.Mesh(capGeometry, capMaterial);
    topCap.position.set(0, gapPosition + PIPE_GAP / 2, zPosition);
    sceneRef.current.add(topCap);
    
    pipesRef.current.push({
      bottom: bottomPipe,
      top: topPipe,
      bottomCap,
      topCap,
      z: zPosition,
      passed: false,
      gapY: gapPosition,
      width: pipeWidth
    });
  };

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
    } catch (err) {
      const error = err as { name?: string; message?: string };
      setError(error.name === 'NotAllowedError' ? 'Camera permission denied' : 'Camera error: ' + (error.message || 'Unknown error'));
    }
  };

  const startGame = () => {
    birdYRef.current = 0;
    birdVelocityRef.current = 0;
    pipesRef.current = [];
    gameOverRef.current = false;
    frameCountRef.current = 0;
    lastObstacleZRef.current = -25;
    isGameRunningRef.current = true;
    setMyScore(0);
    repStateRef.current = 'waiting';
    
    // Create initial pipes
    for (let i = 0; i < 5; i++) {
      createObstacle(-25 - i * 25);
    }
    
    const gameLoop = () => {
      if (!isGameRunningRef.current) return;
      
      updateGame();
      drawWebcam();
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
      
      animationFrameRef.current = requestAnimationFrame(gameLoop);
    };
    
    gameLoop();
  };

  const updateGame = () => {
    if (gameOverRef.current || !birdRef.current || !sceneRef.current || !cameraRef.current) return;
    
    // Hand detection (reduced frequency for performance)
    if (
      frameCountRef.current % 3 === 0 && // Process every third frame
      videoRef.current &&
      handLandmarkerRef.current &&
      videoRef.current.readyState === videoRef.current.HAVE_ENOUGH_DATA
    ) {
      const results = handLandmarkerRef.current.detectForVideo(videoRef.current, performance.now());
      
      if (results?.landmarks && results.landmarks.length > 0) {
        const hand = results.landmarks[0] as Array<{ x: number; y: number; z: number }>;
        const wrist = hand[0];
        const handY = wrist.y;
        
        if (lastHandYRef.current !== null) {
          const deltaY = handY - lastHandYRef.current;
          
          if (repStateRef.current === 'waiting' && deltaY < -MOVEMENT_THRESHOLD) {
            // Started moving up
            repStateRef.current = 'up';
          } else if (repStateRef.current === 'up' && deltaY > MOVEMENT_THRESHOLD) {
            // Completed rep: moved up then down
            repStateRef.current = 'waiting';
            birdVelocityRef.current = FLAP_STRENGTH;
          }
        }
        
        lastHandYRef.current = handY;
      }
    }
    
    // Bird physics
    birdVelocityRef.current += GRAVITY;
    birdYRef.current += birdVelocityRef.current * 0.01;
    birdRef.current.position.y = birdYRef.current;
    birdRef.current.rotation.x = Math.max(-0.5, Math.min(0.5, -birdVelocityRef.current * 0.05));
    
    // Position bird horizontally based on player index
    const playerIndex = players.findIndex(p => p.id === myPlayerId);
    const numPlayers = players.length;
    const spacing = 6; // Increased spacing to prevent overlap
    const totalWidth = (numPlayers - 1) * spacing;
    const xOffset = playerIndex * spacing - totalWidth / 2;
    birdRef.current.position.x = xOffset;
    
    // Update opponent birds positions first
    opponentBirdsRef.current.forEach((opponent, playerId) => {
      const opponentIndex = players.findIndex(p => p.id === playerId);
      const opponentXOffset = opponentIndex * spacing - totalWidth / 2;
      opponent.mesh.position.set(opponentXOffset, opponent.y, 0);
    });
    
    // Camera follow - spectate last two alive players when dead
    if (gameOverRef.current && alivePlayers.size >= 2) {
      // Spectate the last two alive players
      spectatingRef.current = true;
      
      // Get alive player IDs
      const alivePlayerIds = Array.from(alivePlayers);
      
      // Find average position of alive players
      let totalY = 0;
      let totalX = 0;
      let count = 0;
      
      alivePlayerIds.forEach(playerId => {
        const opponent = opponentBirdsRef.current.get(playerId);
        if (opponent && opponent.isAlive) {
          totalY += opponent.y;
          totalX += opponent.mesh.position.x;
          count++;
        }
      });
      
      if (count > 0) {
        const avgY = totalY / count;
        const avgX = totalX / count;
        cameraRef.current.position.y += (avgY - cameraRef.current.position.y) * 0.05;
        cameraRef.current.position.x += (avgX - cameraRef.current.position.x) * 0.05;
        cameraRef.current.lookAt(avgX, avgY, -10);
      }
    } else if (!gameOverRef.current) {
      cameraRef.current.position.y += (birdYRef.current - cameraRef.current.position.y) * 0.08;
      cameraRef.current.position.x += (xOffset - cameraRef.current.position.x) * 0.08; // Follow player X position smoothly
      cameraRef.current.lookAt(xOffset, birdYRef.current, -10);
      spectatingRef.current = false;
    }
    
    // Broadcast position (reduced frequency for performance)
    if (socketRef.current && roomCodeRef.current && frameCountRef.current % 5 === 0) {
      socketRef.current.emit('update-position', {
        roomCode: roomCodeRef.current,
        y: birdYRef.current,
        isAlive: !gameOverRef.current
      });
    }
    
    // Bounds check
    if (birdYRef.current > CEILING_LEVEL - 0.8 || birdYRef.current < GROUND_LEVEL + 0.8) {
      gameOverRef.current = true;
      if (socketRef.current && roomCodeRef.current) {
        socketRef.current.emit('player-died', { roomCode: roomCodeRef.current });
      }
      return;
    }
    
    // Pipe generation
    frameCountRef.current++;
    if (frameCountRef.current % 100 === 0) { // Generate pipes more frequently for better gameplay
      lastObstacleZRef.current -= 25;
      createObstacle(lastObstacleZRef.current);
    }
    
    // Update pipes
    for (let i = pipesRef.current.length - 1; i >= 0; i--) {
      const pipe = pipesRef.current[i];
      pipe.z += PIPE_SPEED;
      pipe.bottom.position.z = pipe.z;
      pipe.top.position.z = pipe.z;
      pipe.bottomCap.position.z = pipe.z;
      pipe.topCap.position.z = pipe.z;
      
      // Score check
      if (!pipe.passed && pipe.z > 0) {
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
      if (pipe.z > -2.5 && pipe.z < 2.5) {
        if (birdYRef.current < pipe.gapY - PIPE_GAP / 2 || birdYRef.current > pipe.gapY + PIPE_GAP / 2) {
          if (Math.abs(birdRef.current.position.x) < pipe.width / 2) {
            gameOverRef.current = true;
            if (socketRef.current && roomCodeRef.current) {
              socketRef.current.emit('player-died', { roomCode: roomCodeRef.current });
            }
          }
        }
      }
      
      // Remove off-screen pipes
      if (pipe.z > 20) {
        sceneRef.current?.remove(pipe.bottom);
        sceneRef.current?.remove(pipe.top);
        sceneRef.current?.remove(pipe.bottomCap);
        sceneRef.current?.remove(pipe.topCap);
        pipesRef.current.splice(i, 1);
      }
    }
  };

  const drawWebcam = () => {
    const canvas = webcamCanvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || video.readyState !== video.HAVE_ENOUGH_DATA) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
    ctx.restore();
    
    if (handLandmarkerRef.current && video.readyState === video.HAVE_ENOUGH_DATA) {
      const results = handLandmarkerRef.current.detectForVideo(video, performance.now());
      
      if (results?.landmarks && results.landmarks.length > 0) {
        const hand = results.landmarks[0] as Array<{ x: number; y: number; z: number }>;
        
        ctx.fillStyle = '#00f5ff';
        ctx.strokeStyle = '#00f5ff';
        ctx.lineWidth = 2;
        
        hand.forEach((landmark) => {
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
    setError('');
    roomCodeRef.current = upperRoomCode;
    socketRef.current.emit('join-room', { roomCode: upperRoomCode, playerName });
  };

  const startGameManually = () => {
    if (!socketRef.current || !roomCodeRef.current) return;
    socketRef.current.emit('start-game', { roomCode: roomCodeRef.current });
  };

  if (gameState === 'menu') {
    return (
      <div className="flex min-h-screen w-full bg-black text-white flex-col items-center justify-center p-4">
        <h1 className="text-6xl font-bold mb-4" style={{ textShadow: '0 0 20px #00f5ff' }}>
          FLAPPY GOON 3D
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
          
          <div className="space-y-4 mb-6">
            {players.map((player, idx) => (
              <div key={player.id} className="p-4 bg-gray-800 rounded-lg">
                <p className="text-xl">
                  Player {idx + 1}: {player.name}
                  {player.id === myPlayerId && ' (You)'}
                  {isCreator && player.id ===myPlayerId && ' - Host'}
                </p>
              </div>
            ))}
            
            {Array.from({ length: 4 - players.length }).map((_, idx) => (
              <div key={`empty-${idx}`} className="p-4 bg-gray-800 rounded-lg border-2 border-dashed border-gray-600">
                <p className="text-xl text-gray-400">Waiting...</p>
              </div>
            ))}
          </div>
          
          {isCreator && (
            <button
              onClick={startGameManually}
              className="w-full px-6 py-4 bg-gradient-to-r from-green-600 to-blue-600 hover:from-green-500 hover:to-blue-500 text-white font-bold rounded-lg transition-all uppercase"
            >
              Start Game ({players.length} Player{players.length !== 1 ? 's' : ''})
            </button>
          )}
          
          {!isCreator && (
            <p className="text-center text-gray-400">Waiting for host to start...</p>
          )}
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
        <div className="mb-8">
          <h2 className="text-3xl mb-4">Final Scores:</h2>
          {players.sort((a, b) => b.score - a.score).map((player, idx) => (
            <p key={player.id} className="text-2xl mb-2">
              {idx + 1}. {player.name}: {player.score} points
              {player.id === myPlayerId && ' (You)'}
            </p>
          ))}
        </div>
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
      <div ref={containerRef} className="border-4 border-cyan-500" style={{ boxShadow: '0 0 30px rgba(0, 245, 255, 0.5)' }} />
      
      {/* Webcam Corner View */}
      <div className="absolute top-4 right-4 z-50">
        <div className="border-4 border-pink-500 rounded-lg overflow-hidden" style={{ boxShadow: '0 0 20px rgba(255, 105, 180, 0.5)' }}>
          <canvas ref={webcamCanvasRef} width={240} height={180} />
        </div>
        <p className="text-center text-white mt-2 text-sm font-bold">Your Camera</p>
      </div>
      
      {/* Scoreboard */}
      <div className="absolute top-4 left-4 bg-black bg-opacity-70 px-4 py-3 rounded-lg border-2 border-cyan-500">
        {players.map((player) => (
          <p key={player.id} className="text-xl font-bold" style={{ color: player.id === myPlayerId ? '#00f5ff' : '#ffffff' }}>
            {player.name}: {player.score}
            {player.id === myPlayerId && ' (You)'}
          </p>
        ))}
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
