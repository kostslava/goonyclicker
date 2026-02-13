'use client';

import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import * as THREE from 'three';

const MOVEMENT_THRESHOLD = 0.015;
const DEFAULT_TIME_LIMIT = 120;
const GRAVITY = -0.8;
const FLAP_STRENGTH = 12;
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
  targetY: number;
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
  const [countdown, setCountdown] = useState<number | null>(null);
  const [isDead, setIsDead] = useState(false);
  
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
  const readyTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastPositionUpdateRef = useRef<number>(0);
  const isRoomCreatorRef = useRef<boolean>(false);
  const revealedPipeIndexRef = useRef<number>(0);
  const gameStartTimeRef = useRef<number>(0);
  const sharedStartTimeRef = useRef<number>(0);

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
      isRoomCreatorRef.current = true;
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
      setAlivePlayers(new Set(players.map((p: Player) => p.id)));
      setIsDead(false);
      setError('Initializing camera...');
      
      // Initialize camera and wait for ready signal
      setTimeout(initHandTrackingCallback, 100);
      
      // Fallback: auto-start after 10 seconds even if not all players ready
      readyTimeoutRef.current = setTimeout(() => {
        console.log('Timeout reached, forcing game start');
        newSocket.emit('force-start-countdown', { roomCode: roomCodeRef.current });
      }, 10000);
    });

    newSocket.on('all-players-ready', ({ startTime }: { startTime: number }) => {
      console.log('All players ready, starting countdown, shared start time:', startTime);
      
      // Clear the timeout since we're starting
      if (readyTimeoutRef.current) {
        clearTimeout(readyTimeoutRef.current);
        readyTimeoutRef.current = null;
      }
      
      setError(''); // Clear any error messages
      
      // Store shared start time from server
      sharedStartTimeRef.current = startTime;
      
      // Start countdown
      setCountdown(3);
      const countdownInterval = setInterval(() => {
        setCountdown(prev => {
          if (prev === null || prev <= 1) {
            clearInterval(countdownInterval);
            setCountdown(null);
            
            // Start the game running
            isGameRunningRef.current = true;
            gameStartTimeRef.current = performance.now();
            
            // Start timer that calculates from shared server time
            if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
            timerIntervalRef.current = setInterval(() => {
              const elapsedMs = Date.now() - sharedStartTimeRef.current;
              const elapsedSeconds = Math.floor(elapsedMs / 1000);
              const remaining = Math.max(0, timeLimit - elapsedSeconds);
              
              setTimeRemaining(remaining);
              
              if (remaining <= 0) {
                if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
                setTimeout(() => {
                  socketRef.current?.emit('game-over', { roomCode: roomCodeRef.current });
                }, 100);
              }
            }, 100); // Update every 100ms for better accuracy
            
            return null;
          }
          return prev - 1;
        });
      }, 1000);
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
        
        // Set initial horizontal position immediately - all birds at same Z depth
        const currentPlayers = players.length > 0 ? players : [];
        const opponentIndex = currentPlayers.findIndex(p => p.id === playerId);
        if (opponentIndex !== -1) {
          const spacing = 6;
          const totalWidth = (currentPlayers.length - 1) * spacing;
          const xOffset = opponentIndex * spacing - totalWidth / 2;
          bird.position.x = xOffset;
          bird.position.z = 0; // All birds at same depth
        }
        
        opponent = { mesh: bird, y, targetY: y, isAlive };
        opponents.set(playerId, opponent);
      }
      
      if (opponent) {
        // Set target position for interpolation
        opponent.targetY = y;
        opponent.isAlive = isAlive;
        opponent.mesh.visible = isAlive;
      }
    });

    newSocket.on('reveal-pipe', ({ index }) => {
      // Synchronize pipe reveal across all clients
      revealedPipeIndexRef.current = Math.max(revealedPipeIndexRef.current, index);
      
      // Reveal all pipes up to this index
      for (let i = 0; i <= index && i < pipesRef.current.length; i++) {
        const pipe = pipesRef.current[i];
        pipe.bottom.visible = true;
        pipe.top.visible = true;
        pipe.bottomCap.visible = true;
        pipe.topCap.visible = true;
      }
    });

    newSocket.on('player-died', ({ playerId }) => {
      setAlivePlayers(prev => {
        const newAlive = new Set(prev);
        newAlive.delete(playerId);
        
        // Check if only one player left (winner)
        if (newAlive.size === 1) {
          const winnerId = Array.from(newAlive)[0];
          const winnerPlayer = players.find(p => p.id === winnerId);
          if (winnerPlayer) {
            // Award point to winner
            socketRef.current?.emit('update-score', { 
              roomCode: roomCodeRef.current, 
              score: winnerPlayer.score + 1 
            });
            
            // Send winner signal to go back to lobby
            setTimeout(() => {
              socketRef.current?.emit('winner-found', { 
                roomCode: roomCodeRef.current,
                winnerId 
              });
            }, 2000);
          }
        }
        // Check if all players are dead (tie)
        else if (newAlive.size === 0) {
          // All players dead, go back to lobby
          setTimeout(() => {
            socketRef.current?.emit('winner-found', { 
              roomCode: roomCodeRef.current,
              winnerId: null
            });
          }, 2000);
        }
        
        return newAlive;
      });
    });

    newSocket.on('return-to-lobby', ({ players }) => {
      console.log('Returning to lobby! Players:', players);
      
      // Stop game
      isGameRunningRef.current = false;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      if (readyTimeoutRef.current) {
        clearTimeout(readyTimeoutRef.current);
        readyTimeoutRef.current = null;
      }
      
      // Stop webcam
      if (videoRef.current?.srcObject) {
        const tracks = (videoRef.current.srcObject as MediaStream).getTracks();
        tracks.forEach(track => track.stop());
        videoRef.current.srcObject = null;
      }
      
      // Clear tracking
      setIsTracking(false);
      handLandmarkerRef.current = null;
      
      // Update players and go to lobby
      setPlayers(players);
      setGameState('lobby');
      setWinner(null);
      setError('');
      setIsDead(false);
      
      // Clear scene
      if (sceneRef.current) {
        pipesRef.current.forEach(pipe => {
          sceneRef.current?.remove(pipe.bottom);
          sceneRef.current?.remove(pipe.top);
          sceneRef.current?.remove(pipe.bottomCap);
          sceneRef.current?.remove(pipe.topCap);
        });
        opponentBirdsRef.current.forEach(opponent => {
          sceneRef.current?.remove(opponent.mesh);
        });
        opponentBirdsRef.current.clear();
      }
    });

    newSocket.on('error', (msg) => {
      console.error('Socket error:', msg);
      setError(msg);
    });

    return () => {
      isGameRunningRef.current = false;
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      if (readyTimeoutRef.current) clearTimeout(readyTimeoutRef.current);
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

    const camera = new THREE.PerspectiveCamera(75, 800 / 600, 0.1, 100); // Reduced far plane from 1000 to 100
    camera.position.set(0, 2, 10);
    camera.lookAt(0, 0, -10);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ 
      antialias: false,
      powerPreference: 'low-power', // Prefer integrated GPU for better battery/performance
      precision: 'lowp' // Low precision for better performance
    });
    renderer.setSize(800, 600);
    renderer.setPixelRatio(1); // Fixed at 1 for performance
    const container = containerRef.current;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Lighting - simplified for performance
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.2); // Single light source
    scene.add(ambientLight);

    // Create player bird
    const bird = createBird(0xFFD700);
    // Position bird on X axis (width) - will be updated in game loop
    bird.position.set(0, 0, 0);
    scene.add(bird);
    birdRef.current = bird;

    // Create ground - using MeshBasicMaterial for performance
    const groundGeometry = new THREE.PlaneGeometry(60, 250);
    const groundMaterial = new THREE.MeshBasicMaterial({ color: 0x7CFC00, side: THREE.DoubleSide });
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
    
    // Body - minimal segments for performance
    const bodyGeometry = new THREE.SphereGeometry(0.8, 6, 4); // Reduced from 12,8 to 6,4
    const bodyMaterial = new THREE.MeshBasicMaterial({ color }); // MeshBasicMaterial is much faster
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    bird.add(body);
    
    // Wings - simplified
    const wingGeometry = new THREE.BoxGeometry(0.3, 0.1, 1);
    const wingMaterial = new THREE.MeshBasicMaterial({ color: color === 0xFFD700 ? 0xFFA500 : 0x00CED1 });
    
    const leftWing = new THREE.Mesh(wingGeometry, wingMaterial);
    leftWing.position.set(-0.7, 0, 0);
    bird.add(leftWing);
    
    const rightWing = new THREE.Mesh(wingGeometry, wingMaterial);
    rightWing.position.set(0.7, 0, 0);
    bird.add(rightWing);
    
    // Beak - minimal geometry
    const beakGeometry = new THREE.ConeGeometry(0.2, 0.5, 3); // Reduced to 3 segments
    const beakMaterial = new THREE.MeshBasicMaterial({ color: 0xFF6347 });
    const beak = new THREE.Mesh(beakGeometry, beakMaterial);
    beak.position.set(0, 0, 0.8);
    beak.rotation.x = Math.PI / 2;
    bird.add(beak);
    
    // Eyes - minimal geometry
    const eyeGeometry = new THREE.SphereGeometry(0.15, 4, 3); // Reduced segments
    const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    
    const leftEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    leftEye.position.set(0.3, 0.3, 0.6);
    bird.add(leftEye);
    
    const rightEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    rightEye.position.set(-0.3, 0.3, 0.6);
    bird.add(rightEye);
    
    return bird;
  };

  const createObstacle = (zPosition: number, isVisible: boolean = false, seed?: number, playerXOffset: number = 0) => {
    if (!sceneRef.current) return;
    
    // Use seed for consistent random generation across all clients
    const randomValue = seed !== undefined ? seed : Math.random();
    const gapPosition = GROUND_LEVEL + 2 + randomValue * 10;
    
    // Calculate pipe width based on number of players - needs to encompass all birds
    const numPlayers = players.length || 1;
    const birdSpacing = 6;
    const totalBirdWidth = (numPlayers - 1) * birdSpacing;
    const pipeWidth = Math.max(PIPE_WIDTH, totalBirdWidth + 8); // +8 for margin on both sides
    
    // Bottom pipe - using MeshBasicMaterial for performance
    const bottomHeight = gapPosition - GROUND_LEVEL - PIPE_GAP / 2;
    const bottomGeometry = new THREE.BoxGeometry(pipeWidth, bottomHeight, pipeWidth);
    const pipeMaterial = new THREE.MeshBasicMaterial({ color: 0x228B22 }); // Changed to MeshBasicMaterial
    const bottomPipe = new THREE.Mesh(bottomGeometry, pipeMaterial);
    bottomPipe.position.set(playerXOffset, GROUND_LEVEL + bottomHeight / 2, zPosition); // Centered on player
    bottomPipe.visible = isVisible;
    sceneRef.current.add(bottomPipe);
    
    // Top pipe
    const topHeight = CEILING_LEVEL - gapPosition - PIPE_GAP / 2;
    const topGeometry = new THREE.BoxGeometry(pipeWidth, topHeight, pipeWidth);
    const topPipe = new THREE.Mesh(topGeometry, pipeMaterial);
    topPipe.position.set(playerXOffset, gapPosition + PIPE_GAP / 2 + topHeight / 2, zPosition); // Centered on player
    topPipe.visible = isVisible;
    sceneRef.current.add(topPipe);
    
    // Caps - using MeshBasicMaterial for performance
    const capGeometry = new THREE.BoxGeometry(pipeWidth + 1, 0.5, pipeWidth + 1);
    const capMaterial = new THREE.MeshBasicMaterial({ color: 0x006400 }); // Changed to MeshBasicMaterial
    
    const bottomCap = new THREE.Mesh(capGeometry, capMaterial);
    bottomCap.position.set(playerXOffset, gapPosition - PIPE_GAP / 2, zPosition); // Centered on player
    bottomCap.visible = isVisible;
    sceneRef.current.add(bottomCap);
    
    const topCap = new THREE.Mesh(capGeometry, capMaterial);
    topCap.position.set(playerXOffset, gapPosition + PIPE_GAP / 2, zPosition); // Centered on player
    topCap.visible = isVisible;
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
        video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } } // Reduced from 640x480
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
      setError(''); // Clear error on success
      
      // Signal that this player's camera is ready
      if (socketRef.current && roomCodeRef.current) {
        socketRef.current.emit('player-ready', { roomCode: roomCodeRef.current });
      }
      
      startGame();
    } catch (err) {
      const error = err as { name?: string; message?: string };
      const errorMsg = error.name === 'NotAllowedError' ? 'Camera permission denied' : 'Camera error: ' + (error.message || 'Unknown error');
      setError(errorMsg);
      console.error('Camera initialization failed:', errorMsg);
      
      // Still signal ready even if camera fails, so game can start for other players
      if (socketRef.current && roomCodeRef.current) {
        socketRef.current.emit('player-ready', { roomCode: roomCodeRef.current });
      }
      
      // Start game loop anyway (player just won't have hand tracking)
      startGame();
    }
  };

  const startGame = () => {
    birdYRef.current = 0;
    birdVelocityRef.current = 0;
    pipesRef.current = [];
    gameOverRef.current = false;
    frameCountRef.current = 0;
    lastObstacleZRef.current = -25;
    isGameRunningRef.current = false;
    revealedPipeIndexRef.current = -1;
    gameStartTimeRef.current = 0;
    setMyScore(0);
    setIsDead(false);
    
    // Reset bird visual state
    if (birdRef.current) {
      birdRef.current.rotation.z = 0;
      birdRef.current.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          if (child.material instanceof THREE.MeshBasicMaterial) {
            child.material.transparent = false;
            child.material.opacity = 1.0;
          }
        }
      });
    }
    
    // Pre-create first 30 pipes (reduced from 50 for performance)
    // Use deterministic seeds for consistent obstacle placement across all clients
    const playerIndex = players.findIndex(p => p.id === myPlayerId);
    const numPlayers = players.length;
    const spacing = 6;
    const totalWidth = (numPlayers - 1) * spacing;
    const playerXOffset = playerIndex * spacing - totalWidth / 2;
    
    for (let i = 0; i < 30; i++) {
      // Use a deterministic seed based on index for consistent random values
      const seed = (Math.sin(i * 12.9898) + 1) / 2; // Generates value between 0 and 1
      createObstacle(-25 - i * 25, false, seed, playerXOffset);
    }
    
    const gameLoop = () => {
      // Only update game physics when game is actually running (after countdown)
      if (isGameRunningRef.current) {
        updateGame();
        // Draw webcam less frequently for performance (every 3rd frame)
        if (frameCountRef.current % 3 === 0) {
          drawWebcam();
        }
      }
      
      // Always render the scene (to show countdown state)
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
      
      frameCountRef.current++;
      animationFrameRef.current = requestAnimationFrame(gameLoop);
    };
    
    gameLoop();
  };

  const updateGame = () => {
    if (!birdRef.current || !sceneRef.current || !cameraRef.current) return;
    
    // Only process player physics and input if player is alive AND game is running
    if (!gameOverRef.current && isGameRunningRef.current) {
      // Hand detection every other frame for better performance
      if (
        frameCountRef.current % 2 === 0 &&
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
            
            // Allow jump on upward motion only for better responsiveness
            if (deltaY < -MOVEMENT_THRESHOLD) {
              // Moving up - trigger jump
              birdVelocityRef.current = FLAP_STRENGTH;
              console.log('FLAP!');
              // Update last position to prevent multiple jumps from same motion
              lastHandYRef.current = handY;
            } else if (Math.abs(deltaY) < MOVEMENT_THRESHOLD / 2) {
              // Small movement - update tracking for next jump detection
              lastHandYRef.current = handY;
            }
          } else {
            lastHandYRef.current = handY;
          }
          
          lastHandYRef.current = handY;
        } else {
          // No hand detected, reset lastHandY to prevent false detections
          lastHandYRef.current = null;
        }
      }
      
      // Bird physics
      birdVelocityRef.current += GRAVITY;
      birdYRef.current += birdVelocityRef.current * 0.01;
      birdRef.current.position.y = birdYRef.current;
      birdRef.current.rotation.x = Math.max(-0.5, Math.min(0.5, -birdVelocityRef.current * 0.05));
    } else if (gameOverRef.current) {
      // Death animation - make bird fall and fade
      birdVelocityRef.current += GRAVITY * 1.5; // Fall faster when dead
      birdYRef.current += birdVelocityRef.current * 0.01;
      birdRef.current.position.y = birdYRef.current;
      birdRef.current.rotation.z += 0.05; // Spin while falling
      
      // Fade out the bird
      birdRef.current.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          if (child.material instanceof THREE.MeshBasicMaterial) {
            child.material.transparent = true;
            child.material.opacity = Math.max(0.3, child.material.opacity - 0.01);
          }
        }
      });
    }
    
    // Position bird horizontally based on player index
    const playerIndex = players.findIndex(p => p.id === myPlayerId);
    const numPlayers = players.length;
    const spacing = 6; // Spacing between birds on X axis
    const totalWidth = (numPlayers - 1) * spacing;
    const xOffset = playerIndex * spacing - totalWidth / 2;
    birdRef.current.position.x = xOffset;
    birdRef.current.position.z = 0; // Keep all birds at same depth
    
    // Ensure bird stays at Y=0 during countdown (when game not running)
    if (!isGameRunningRef.current && !gameOverRef.current) {
      birdRef.current.position.y = 0;
      birdYRef.current = 0;
      birdVelocityRef.current = 0;
    }
    
    // Update opponent birds positions with interpolation for smooth movement
    opponentBirdsRef.current.forEach((opponent, playerId) => {
      const opponentIndex = players.findIndex(p => p.id === playerId);
      const opponentXOffset = opponentIndex * spacing - totalWidth / 2;
      
      // Smooth interpolation for Y position (lerp with factor 0.3 for responsiveness)
      opponent.y += (opponent.targetY - opponent.y) * 0.3;
      opponent.mesh.position.set(opponentXOffset, opponent.y, 0); // All birds at same depth
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
        if (cameraRef.current) {
          cameraRef.current.position.y += (avgY - cameraRef.current.position.y) * 0.05;
          cameraRef.current.position.x += (avgX - cameraRef.current.position.x) * 0.05;
          cameraRef.current.lookAt(avgX, avgY, -10);
        }
      }
    } else if (!gameOverRef.current && cameraRef.current) {
      cameraRef.current.position.y += (birdYRef.current - cameraRef.current.position.y) * 0.08;
      cameraRef.current.position.x += (xOffset - cameraRef.current.position.x) * 0.08; // Follow player X position smoothly
      cameraRef.current.lookAt(xOffset, birdYRef.current, -10);
      spectatingRef.current = false;
    }
    
    // Broadcast position at max 25ms intervals (40 FPS) for smooth real-time sync
    // Only broadcast when game is actually running to reduce network traffic during countdown
    const now = performance.now();
    if (isGameRunningRef.current && socketRef.current && roomCodeRef.current && now - lastPositionUpdateRef.current >= 25) {
      socketRef.current.emit('update-position', {
        roomCode: roomCodeRef.current,
        y: birdYRef.current,
        isAlive: !gameOverRef.current
      });
      lastPositionUpdateRef.current = now;
    }
    
    // Only update game state when game is running (after countdown)
    if (isGameRunningRef.current) {
      // Bounds check (only for alive players)
      if (!gameOverRef.current) {
        if (birdYRef.current > CEILING_LEVEL - 0.8 || birdYRef.current < GROUND_LEVEL + 0.8) {
          gameOverRef.current = true;
          setIsDead(true);
          if (socketRef.current && roomCodeRef.current) {
            socketRef.current.emit('player-died', { roomCode: roomCodeRef.current });
          }
        }
      }
      
      // Pipe reveal logic - synchronized across all clients based on game time
      if (isRoomCreatorRef.current && socketRef.current && roomCodeRef.current) {
        const elapsedTime = (performance.now() - gameStartTimeRef.current) / 1000; // seconds
        const pipesToReveal = Math.floor(elapsedTime / 0.67); // Reveal one pipe every 0.67 seconds (100 frames at ~60fps)
        
        if (pipesToReveal > revealedPipeIndexRef.current && pipesToReveal < 30) {
          revealedPipeIndexRef.current = pipesToReveal;
          socketRef.current.emit('reveal-pipe', {
            roomCode: roomCodeRef.current,
            index: pipesToReveal
          });
          
          // Reveal locally for creator
          const pipe = pipesRef.current[pipesToReveal];
          if (pipe) {
            pipe.bottom.visible = true;
            pipe.top.visible = true;
            pipe.bottomCap.visible = true;
            pipe.topCap.visible = true;
          }
        }
      }
      
      // Update pipes
      for (let i = pipesRef.current.length - 1; i >= 0; i--) {
        const pipe = pipesRef.current[i];
        pipe.z += PIPE_SPEED;
        
        // Update pipe positions - keep them centered on player's X position
        pipe.bottom.position.set(xOffset, pipe.bottom.position.y, pipe.z);
        pipe.top.position.set(xOffset, pipe.top.position.y, pipe.z);
        pipe.bottomCap.position.set(xOffset, pipe.bottomCap.position.y, pipe.z);
        pipe.topCap.position.set(xOffset, pipe.topCap.position.y, pipe.z);
        
        // Score check (only for alive players)
        if (!gameOverRef.current && !pipe.passed && pipe.z > 0) {
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
        
        // Collision check (only for alive players)
        if (!gameOverRef.current && pipe.z > -2.5 && pipe.z < 2.5) {
          const BIRD_RADIUS = 0.8;
          const birdX = birdRef.current.position.x;
          const birdY = birdYRef.current;
          const pipeX = pipe.bottom.position.x;
          
          // Check if bird is within pipe's X bounds (accounting for bird radius)
          const isInPipeXRange = Math.abs(birdX - pipeX) < pipe.width / 2 + BIRD_RADIUS;
          
          // Check if bird is outside the gap vertically (accounting for bird radius)
          const isOutsideGap = birdY < pipe.gapY - PIPE_GAP / 2 + BIRD_RADIUS || 
                               birdY > pipe.gapY + PIPE_GAP / 2 - BIRD_RADIUS;
          
          if (isInPipeXRange && isOutsideGap) {
            gameOverRef.current = true;
            setIsDead(true);
            if (socketRef.current && roomCodeRef.current) {
              socketRef.current.emit('player-died', { roomCode: roomCodeRef.current });
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
    }
  };

  const drawWebcam = () => {
    const canvas = webcamCanvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || video.readyState !== video.HAVE_ENOUGH_DATA) return;
    
    const ctx = canvas.getContext('2d', { alpha: false }); // Disable alpha for performance
    if (!ctx) return;
    
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
    ctx.restore();
    
    // Only draw hand landmarks every other webcam render for performance
    if (frameCountRef.current % 6 === 0 && handLandmarkerRef.current && video.readyState === video.HAVE_ENOUGH_DATA) {
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
          Hand Gesture Bird Race
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
          <canvas ref={webcamCanvasRef} width={160} height={120} />
        </div>
        <p className="text-center text-white mt-2 text-sm font-bold">Your Camera</p>
      </div>
      
      {/* Scoreboard */}
      <div className="absolute top-4 left-4 bg-black bg-opacity-80 px-4 py-3 rounded-lg border-2 border-cyan-500 z-20">
        {players.map((player) => (
          <p key={player.id} className="text-xl font-bold" style={{ color: player.id === myPlayerId ? '#00f5ff' : '#ffffff' }}>
            {player.name}: {player.score}
            {player.id === myPlayerId && ' (You)'}
          </p>
        ))}
      </div>
      
      {/* Timer - Highly visible */}
      <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-black bg-opacity-90 px-8 py-4 rounded-lg border-4 border-cyan-400 z-30" style={{ boxShadow: '0 0 25px rgba(0, 245, 255, 0.8)' }}>
        <p className="text-5xl font-bold text-cyan-400" style={{ textShadow: '0 0 15px #00f5ff, 0 0 30px #00f5ff' }}>
          {Math.floor(timeRemaining / 60)}:{(timeRemaining % 60).toString().padStart(2, '0')}
        </p>
      </div>
      
      {/* Countdown Overlay */}
      {countdown !== null && (
        <div className="absolute inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50">
          <h1 className="text-9xl font-bold text-white animate-pulse" style={{ textShadow: '0 0 40px #00f5ff' }}>
            {countdown === 0 ? 'GO!' : countdown}
          </h1>
        </div>
      )}
      
      {/* Death Indicator */}
      {isDead && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-40">
          <div className="text-center">
            <h1 className="text-8xl font-bold text-red-600 animate-pulse" style={{ textShadow: '0 0 40px #ff0000' }}>
              YOU DIED
            </h1>
            <p className="text-3xl text-white mt-4" style={{ textShadow: '0 0 20px #000000' }}>
              Spectating...
            </p>
          </div>
        </div>
      )}
      
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
