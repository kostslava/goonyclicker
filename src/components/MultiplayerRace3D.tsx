'use client';

import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import * as THREE from 'three';

const MOVEMENT_THRESHOLD = 0.01; // Minimum Y change to register as movement (~5 pixels on 480px canvas)
const MOVEMENT_COOLDOWN = 50; // milliseconds between reps (minimal delay to allow spam)
const PIPE_WIDTH = 6;
const GROUND_LEVEL = -5;
const CEILING_LEVEL = 15;
const DIVE_THRESHOLD = 0.15; // Fast downward motion threshold for dive
const DIVE_DURATION = 500; // Duration of dive gravity boost in ms
const HEAT_RHYTHM_WINDOW = 0.10; // ±10% timing window for heat multiplier
const MAX_HEAT_MULTIPLIER = 3;
const HORIZONTAL_THRESHOLD = 0.03; // Minimum X change for horizontal roll detection
const MEGA_COOKIE_MOTION_THRESHOLD = 0.20; // Large downward motion for mega cookie smash
const WIPE_MOTION_THRESHOLD = 0.15; // Horizontal wipe to clear burnt cookie

// Difficulty settings (no time limits, just game mechanics)
const DIFFICULTY_SETTINGS = {
  easy: {
    gravity: -0.25,
    flapStrength: 7,
    pipeSpeed: 0.05,
    pipeGap: 8
  },
  medium: {
    gravity: -0.4,
    flapStrength: 9,
    pipeSpeed: 0.08,
    pipeGap: 6
  },
  hard: {
    gravity: -0.6,
    flapStrength: 11,
    pipeSpeed: 0.12,
    pipeGap: 5
  }
};

type Difficulty = keyof typeof DIFFICULTY_SETTINGS;
type GameMode = 'race' | 'clicker';
type TimeLimit = 0 | 120 | 300 | 600; // 0 = unlimited, 2, 5, or 10 minutes in seconds

interface Player {
  id: string;
  name: string;
  score: number;
}

interface Upgrade {
  id: string;
  name: string;
  baseCost: number;
  type: 'hand' | 'building';
  multiplier?: number; // For hand upgrades (cookies per click)
  cps?: number; // For building upgrades (cookies per second)
  description: string;
  icon: string;
  requiredNetWorth?: number; // For buildings, unlock at certain net worth
}

const UPGRADES: Upgrade[] = [
  // Hand upgrades - one-time purchases with expensive progression
  {
    id: 'hand_tier1',
    name: 'Stronger Hands',
    baseCost: 100,
    type: 'hand',
    multiplier: 2,
    description: '2x cookies per click',
    icon: '👋'
  },
  {
    id: 'hand_tier2',
    name: 'Iron Grip',
    baseCost: 10000,
    type: 'hand',
    multiplier: 2,
    description: '2x cookies per click',
    icon: '✊'
  },
  {
    id: 'hand_tier3',
    name: 'Titan Fists',
    baseCost: 1000000,
    type: 'hand',
    multiplier: 2,
    description: '2x cookies per click',
    icon: '💪'
  },
  {
    id: 'hand_tier4',
    name: 'God Hands',
    baseCost: 100000000,
    type: 'hand',
    multiplier: 2,
    description: '2x cookies per click',
    icon: '🔥'
  },
  // Building upgrades - incremental cost, unlock based on net worth
  {
    id: 'cursor',
    name: 'Cursor',
    baseCost: 15,
    type: 'building',
    cps: 0.1,
    description: '+0.1 cookie/sec',
    icon: '👆',
    requiredNetWorth: 0
  },
  {
    id: 'grandma',
    name: 'Grandma',
    baseCost: 100,
    type: 'building',
    cps: 1,
    description: '+1 cookie/sec',
    icon: '👵',
    requiredNetWorth: 50
  },
  {
    id: 'farm',
    name: 'Cookie Farm',
    baseCost: 1100,
    type: 'building',
    cps: 8,
    description: '+8 cookies/sec',
    icon: '🌾',
    requiredNetWorth: 500
  },
  {
    id: 'mine',
    name: 'Cookie Mine',
    baseCost: 12000,
    type: 'building',
    cps: 47,
    description: '+47 cookies/sec',
    icon: '⛏️',
    requiredNetWorth: 5000
  },
  {
    id: 'factory',
    name: 'Cookie Factory',
    baseCost: 130000,
    type: 'building',
    cps: 260,
    description: '+260 cookies/sec',
    icon: '🏭',
    requiredNetWorth: 50000
  },
  {
    id: 'bank',
    name: 'Cookie Bank',
    baseCost: 1400000,
    type: 'building',
    cps: 1400,
    description: '+1400 cookies/sec',
    icon: '🏦',
    requiredNetWorth: 500000
  },
  {
    id: 'temple',
    name: 'Cookie Temple',
    baseCost: 20000000,
    type: 'building',
    cps: 7800,
    description: '+7800 cookies/sec',
    icon: '⛩️',
    requiredNetWorth: 5000000
  },
  {
    id: 'spaceship',
    name: 'Cookie Spaceship',
    baseCost: 330000000,
    type: 'building',
    cps: 44000,
    description: '+44000 cookies/sec',
    icon: '🚀',
    requiredNetWorth: 50000000
  }
];

interface Pipe {
  bottom: THREE.Mesh;
  top: THREE.Mesh;
  bottomCap: THREE.Mesh;
  topCap: THREE.Mesh;
  z: number;
  initialZ: number;  // Store original Z position for deterministic updates
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
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [gameMode, setGameMode] = useState<GameMode>('race');
  const [timeLimit, setTimeLimit] = useState<TimeLimit>(300);
  const [remainingTime, setRemainingTime] = useState<number | null>(null);
  const [isCreator, setIsCreator] = useState(false);
  const [clickCount, setClickCount] = useState(0);
  const [alivePlayers, setAlivePlayers] = useState<Set<string>>(new Set());
  const [countdown, setCountdown] = useState<number | null>(null);
  const [isDead, setIsDead] = useState(false);
  const [cookies, setCookies] = useState(0);
  const [ownedUpgrades, setOwnedUpgrades] = useState<Map<string, number>>(new Map());
  const [showShop, setShowShop] = useState(false);
  const [showUpgrades, setShowUpgrades] = useState(false);
  const [cookieCrumbles, setCookieCrumbles] = useState<Array<{ id: number; x: number; y: number }>>([]);
  const [currentHandY, setCurrentHandY] = useState<number | null>(null);
  
  // Dive mechanic (Flappy)
  const [diveActive, setDiveActive] = useState(false);
  
  // Cloud sabotage (Flappy)
  const [cloudOnScreen, setCloudOnScreen] = useState(false);
  const [cloudSabotagePopup, setCloudSabotagePopup] = useState(false);
  
  // Heat multiplier (Cookie)
  const [heatMultiplier, setHeatMultiplier] = useState(1);
  const [cookieGlow, setCookieGlow] = useState(false);
  
  // Mega cookie event (Cookie)
  const [megaCookieEvent, setMegaCookieEvent] = useState(false);
  
  // Dough rolling phase (Cookie)
  const [doughPhaseActive, setDoughPhaseActive] = useState(false);
  const [doughProgress, setDoughProgress] = useState(0);
  
  // Burnt cookie sabotage (Cookie)
  const [burntCookieActive, setBurntCookieActive] = useState(false);
  const [burntCookiePopup, setBurntCookiePopup] = useState(false);
  
  // How-to-play descriptions
  const [hoveredMode, setHoveredMode] = useState<GameMode | null>(null);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const webcamCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const handLandmarkerRef = useRef<{
    detectForVideo: (video: HTMLVideoElement, timestamp: number) => { landmarks?: unknown[][] };
  } | null>(null);
  const lastHandYRef = useRef<number | null>(null);
  const detectionResultsRef = useRef<{ landmarks?: Array<Array<{ x: number; y: number; z: number }>> } | null>(null);
  const gameModeRef = useRef<GameMode>('race');
  const ownedUpgradesRef = useRef<Map<string, number>>(new Map());
  const animationFrameRef = useRef<number | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const roomCodeRef = useRef<string>('');
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const readyTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastPositionUpdateRef = useRef<number>(0);
  const isRoomCreatorRef = useRef<boolean>(false);
  const revealedPipeIndexRef = useRef<number>(0);
  const gameStartTimeRef = useRef<number>(0);
  const sharedStartTimeRef = useRef<number>(0);
  const lastFrameTimeRef = useRef<number>(0);
  
  // Game settings refs
  const gravityRef = useRef(-0.4);
  const flapStrengthRef = useRef(9);
  const pipeSpeedRef = useRef(0.08);
  const pipeGapRef = useRef(6);
  const difficultyRef = useRef<Difficulty>('medium');
  const timeLimitRef = useRef<TimeLimit>(300);

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
  const lastRepTimeRef = useRef<number>(0);
  const handPositionRef = useRef<'up' | 'down' | null>(null);
  const peakHandYRef = useRef<number | null>(null); // Track highest/lowest point for movement detection
  
  // New mechanic refs
  const lastRepTimingsRef = useRef<number[]>([]); // Track timing between reps for heat multiplier
  const lastHandXRef = useRef<number | null>(null); // Track horizontal hand position
  const horizontalRollCountRef = useRef(0); // Count horizontal rolls during dough phase
  const diveTimerRef = useRef<NodeJS.Timeout | null>(null); // Timer for dive duration
  const diveActiveRef = useRef(false); // Ref version for game loop access
  const heatMultiplierRef = useRef(1); // Ref version for game loop access
  const megaCookieEventRef = useRef(false);
  const doughPhaseActiveRef = useRef(false);
  const burntCookieActiveRef = useRef(false);
  const burntCookiePopupRef = useRef(false);
  const cloudSabotagePopupRef = useRef(false);

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

    newSocket.on('game-start', ({ players, difficulty: gameDifficulty, gameMode: mode }) => {
      console.log('Game starting! Players:', players, 'Difficulty:', gameDifficulty, 'Mode:', mode);
      setPlayers(players);
      setGameState('racing');
      
      // Set difficulty and game parameters
      const diff = (gameDifficulty || 'medium') as Difficulty;
      const settings = DIFFICULTY_SETTINGS[diff];
      setDifficulty(diff);
      difficultyRef.current = diff;
      setGameMode((mode || 'race') as GameMode);
      
      // Set game parameter refs
      gravityRef.current = settings.gravity;
      flapStrengthRef.current = settings.flapStrength;
      pipeSpeedRef.current = settings.pipeSpeed;
      pipeGapRef.current = settings.pipeGap;
      setAlivePlayers(new Set(players.map((p: Player) => p.id)));
      setIsDead(false);
      setClickCount(0);
      setCookies(0);
      setOwnedUpgrades(new Map());
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
      
      // Store shared start time from server (THIS IS THE AUTHORITATIVE GAME TIME)
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
            // Calculate exact game start time based on server time + countdown duration
            gameStartTimeRef.current = startTime + 3000; // Server time + 3 second countdown
            
            // Start timer for cookie clicker mode (if time limit is set)
            if (gameModeRef.current === 'clicker' && timeLimitRef.current > 0) {
              setRemainingTime(timeLimitRef.current);
              if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
              
              timerIntervalRef.current = setInterval(() => {
                setRemainingTime(prev => {
                  if (prev === null || prev <= 1) {
                    // Time's up!
                    if (timerIntervalRef.current) {
                      clearInterval(timerIntervalRef.current);
                      timerIntervalRef.current = null;
                    }
                    
                    // Determine winner based on highest score
                    if (socketRef.current && roomCodeRef.current) {
                      socketRef.current.emit('game-over', { roomCode: roomCodeRef.current });
                    }
                    
                    return 0;
                  }
                  return prev - 1;
                });
              }, 1000);
            }
            
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

    // Cloud sabotage: opponent threw a cloud at us
    newSocket.on('cloud-hit', () => {
      console.log('☁️ Cloud hit! View obscured for 3 seconds');
      setCloudOnScreen(true);
      setTimeout(() => setCloudOnScreen(false), 3000);
    });

    // Burnt cookie sabotage: opponent threw a burnt cookie at us
    newSocket.on('burnt-cookie-hit', () => {
      console.log('🔥 Burnt cookie hit! CPS halved until wiped');
      setBurntCookieActive(true);
      burntCookieActiveRef.current = true;
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
      if (diveTimerRef.current) clearTimeout(diveTimerRef.current);
      newSocket.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Passive income generation (CPS) for cookie clicker mode
  useEffect(() => {
    if (gameMode !== 'clicker' || gameState !== 'racing') return;

    const cpsInterval = setInterval(() => {
      setCookies(prevCookies => {
        let totalCPS = 0;
        ownedUpgrades.forEach((count, upgradeId) => {
          const upgrade = UPGRADES.find(u => u.id === upgradeId);
          if (upgrade && upgrade.type === 'building' && upgrade.cps) {
            totalCPS += upgrade.cps * count;
          }
        });

        // Apply burnt cookie penalty: halve CPS
        if (burntCookieActive) {
          totalCPS *= 0.5;
        }

        if (totalCPS > 0) {
          const newCookies = prevCookies + totalCPS;
          setMyScore(newCookies);
          
          if (socketRef.current && roomCodeRef.current) {
            socketRef.current.emit('update-score', { 
              roomCode: roomCodeRef.current, 
              score: newCookies 
            });
          }
          
          return newCookies;
        }
        
        return prevCookies;
      });
    }, 1000); // Run every second

    return () => clearInterval(cpsInterval);
  }, [gameMode, gameState, ownedUpgrades, burntCookieActive]);

  // Sync gameModeRef with gameMode state for use in game loop closures
  useEffect(() => {
    gameModeRef.current = gameMode;
  }, [gameMode]);

  // Sync ownedUpgradesRef with ownedUpgrades state for use in game loop closures
  useEffect(() => {
    ownedUpgradesRef.current = ownedUpgrades;
  }, [ownedUpgrades]);

  // Sync new mechanic refs with state
  useEffect(() => { diveActiveRef.current = diveActive; }, [diveActive]);
  useEffect(() => { heatMultiplierRef.current = heatMultiplier; }, [heatMultiplier]);
  useEffect(() => { megaCookieEventRef.current = megaCookieEvent; }, [megaCookieEvent]);
  useEffect(() => { doughPhaseActiveRef.current = doughPhaseActive; }, [doughPhaseActive]);
  useEffect(() => { burntCookieActiveRef.current = burntCookieActive; }, [burntCookieActive]);
  useEffect(() => { cloudSabotagePopupRef.current = cloudSabotagePopup; }, [cloudSabotagePopup]);
  useEffect(() => { burntCookiePopupRef.current = burntCookiePopup; }, [burntCookiePopup]);
  useEffect(() => { timeLimitRef.current = timeLimit; }, [timeLimit]);

  // Random event system - triggers special events during gameplay
  useEffect(() => {
    if (gameState !== 'racing' || !isGameRunningRef.current) return;

    const eventInterval = setInterval(() => {
      if (!isGameRunningRef.current || gameOverRef.current) return;
      
      const roll = Math.random();
      
      if (gameModeRef.current === 'race') {
        // Cloud sabotage popup (15% chance every 8 seconds)
        if (roll < 0.15 && !cloudSabotagePopupRef.current) {
          setCloudSabotagePopup(true);
          // Auto-dismiss after 3 seconds if not acted upon
          setTimeout(() => setCloudSabotagePopup(false), 3000);
        }
      } else if (gameModeRef.current === 'clicker') {
        if (roll < 0.10 && !megaCookieEventRef.current && !doughPhaseActiveRef.current) {
          // Mega cookie event (10% chance)
          setMegaCookieEvent(true);
          megaCookieEventRef.current = true;
          // Auto-dismiss after 4 seconds
          setTimeout(() => {
            setMegaCookieEvent(false);
            megaCookieEventRef.current = false;
          }, 4000);
        } else if (roll < 0.18 && !doughPhaseActiveRef.current && !megaCookieEventRef.current) {
          // Dough phase (8% chance)
          setDoughPhaseActive(true);
          doughPhaseActiveRef.current = true;
          setDoughProgress(0);
          horizontalRollCountRef.current = 0;
          // Auto-end after 6 seconds
          setTimeout(() => {
            setDoughPhaseActive(false);
            doughPhaseActiveRef.current = false;
            setDoughProgress(0);
          }, 6000);
        } else if (roll < 0.25 && !burntCookiePopupRef.current && players.length > 1) {
          // Burnt cookie sabotage popup (7% chance, only in multiplayer)
          setBurntCookiePopup(true);
          burntCookiePopupRef.current = true;
          setTimeout(() => {
            setBurntCookiePopup(false);
            burntCookiePopupRef.current = false;
          }, 3000);
        }
      }
    }, 8000); // Check every 8 seconds

    return () => clearInterval(eventInterval);
  }, [gameState, players.length]);

  // Apply burnt cookie CPS penalty
  useEffect(() => {
    if (!burntCookieActive) return;
    // The CPS calculation already checks burntCookieActive to halve CPS
    // This effect just ensures the state is tracked
  }, [burntCookieActive]);

  // Three.js setup
  useEffect(() => {
    if (gameState !== 'racing' || !containerRef.current) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(75, 800 / 600, 0.1, 100); // Reduced far plane from 1000 to 100
    camera.position.set(0, 2, 10);
    camera.lookAt(0, 0, 0); // Look at bird starting position
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
    const currentGap = pipeGapRef.current || 6;
    
    // Calculate pipe width based on number of players - needs to encompass all birds
    const numPlayers = players.length || 1;
    const birdSpacing = 6;
    const totalBirdWidth = (numPlayers - 1) * birdSpacing;
    const pipeWidth = Math.max(PIPE_WIDTH, totalBirdWidth + 8); // +8 for margin on both sides
    
    // Determine pipe color based on difficulty
    const pipeColors = {
      easy: 0x228B22,   // Green
      medium: 0xFFD700, // Yellow
      hard: 0xFF0000    // Red
    };
    const capColors = {
      easy: 0x006400,   // Dark Green
      medium: 0xFFA500, // Orange
      hard: 0x8B0000    // Dark Red
    };
    const pipeColor = pipeColors[difficultyRef.current] || pipeColors.medium;
    const capColor = capColors[difficultyRef.current] || capColors.medium;
    
    // Bottom pipe - using MeshBasicMaterial for performance
    const bottomHeight = gapPosition - GROUND_LEVEL - currentGap / 2;
    const bottomGeometry = new THREE.BoxGeometry(pipeWidth, bottomHeight, pipeWidth);
    const pipeMaterial = new THREE.MeshBasicMaterial({ color: pipeColor });
    const bottomPipe = new THREE.Mesh(bottomGeometry, pipeMaterial);
    bottomPipe.position.set(playerXOffset, GROUND_LEVEL + bottomHeight / 2, zPosition); // Centered on player
    bottomPipe.visible = isVisible;
    sceneRef.current.add(bottomPipe);
    
    // Top pipe
    const topHeight = CEILING_LEVEL - gapPosition - currentGap / 2;
    const topGeometry = new THREE.BoxGeometry(pipeWidth, topHeight, pipeWidth);
    const topPipe = new THREE.Mesh(topGeometry, pipeMaterial);
    topPipe.position.set(playerXOffset, gapPosition + currentGap / 2 + topHeight / 2, zPosition); // Centered on player
    topPipe.visible = isVisible;
    sceneRef.current.add(topPipe);
    
    // Caps - using MeshBasicMaterial for performance
    const capGeometry = new THREE.BoxGeometry(pipeWidth + 1, 0.5, pipeWidth + 1);
    const capMaterial = new THREE.MeshBasicMaterial({ color: capColor });
    
    const bottomCap = new THREE.Mesh(capGeometry, capMaterial);
    bottomCap.position.set(playerXOffset, gapPosition - currentGap / 2, zPosition); // Centered on player
    bottomCap.visible = isVisible;
    sceneRef.current.add(bottomCap);
    
    const topCap = new THREE.Mesh(capGeometry, capMaterial);
    topCap.position.set(playerXOffset, gapPosition + currentGap / 2, zPosition); // Centered on player
    topCap.visible = isVisible;
    sceneRef.current.add(topCap);
    
    pipesRef.current.push({
      bottom: bottomPipe,
      top: topPipe,
      bottomCap,
      topCap,
      z: zPosition,
      initialZ: zPosition,  // Store the initial Z position
      passed: false,
      gapY: gapPosition,
      width: pipeWidth
    });
  };

  const initHandTracking = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          facingMode: 'user', 
          width: { ideal: 480 }, 
          height: { ideal: 480 },
          aspectRatio: { ideal: 1.0 } // Request square aspect ratio for MediaPipe
        }
      });
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await new Promise((resolve) => {
          if (videoRef.current) {
            videoRef.current.onloadedmetadata = () => {
              videoRef.current?.play();
              
              // Set canvas size to match actual video dimensions
              if (webcamCanvasRef.current && videoRef.current) {
                const vw = videoRef.current.videoWidth;
                const vh = videoRef.current.videoHeight;
                webcamCanvasRef.current.width = vw;
                webcamCanvasRef.current.height = vh;
                
                // Log actual track settings
                const tracks = (videoRef.current.srcObject as MediaStream).getVideoTracks();
                if (tracks[0]) {
                  const settings = tracks[0].getSettings();
                  console.log('✅ Video element:', vw, 'x', vh);
                  console.log('✅ Stream track:', settings.width, 'x', settings.height);
                  console.log('✅ Canvas buffer:', webcamCanvasRef.current.width, 'x', webcamCanvasRef.current.height);
                }
              }
              
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
        minHandDetectionConfidence: 0.3,  // Lower threshold for better detection (default: 0.5)
        minHandPresenceConfidence: 0.3,   // Lower threshold for better tracking (default: 0.5)
        minTrackingConfidence: 0.3        // Lower threshold for smoother tracking (default: 0.5)
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
    lastFrameTimeRef.current = 0;
    setMyScore(0);
    setIsDead(false);
    setRemainingTime(null);
    
    // Clear any existing timer
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    
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
    
    // Pre-create first 30 pipes (reduced from 50 for performance) - ONLY IN RACE MODE
    // Use deterministic seeds for consistent obstacle placement across all clients
    if (gameModeRef.current === 'race') {
      const playerIndex = players.findIndex(p => p.id === myPlayerId);
      const numPlayers = players.length;
      const spacing = 6;
      const totalWidth = (numPlayers - 1) * spacing;
      const playerXOffset = playerIndex * spacing - totalWidth / 2;
      
      // Initialize bird X position immediately for multiplayer
      if (birdRef.current) {
        birdRef.current.position.x = playerXOffset;
        birdRef.current.position.y = 0;
        birdRef.current.position.z = 0;
      }
      
      for (let i = 0; i < 30; i++) {
        // Use a deterministic seed based on index for consistent random values
        const seed = (Math.sin(i * 12.9898) + 1) / 2; // Generates value between 0 and 1
        createObstacle(-25 - i * 25, false, seed, playerXOffset);
      }
    }
    
    const gameLoop = (currentTime: number) => {
      // Calculate delta time for consistent physics across different frame rates
      if (lastFrameTimeRef.current === 0) {
        lastFrameTimeRef.current = currentTime;
      }
      const deltaTime = Math.min((currentTime - lastFrameTimeRef.current) / 1000, 0.1); // Cap at 0.1s to prevent huge jumps
      lastFrameTimeRef.current = currentTime;
      
      // Run hand detection ONCE per frame and cache results
      // (MediaPipe requires monotonically increasing timestamps - calling twice per frame causes issues)
      if (
        videoRef.current &&
        handLandmarkerRef.current &&
        videoRef.current.readyState >= videoRef.current.HAVE_ENOUGH_DATA
      ) {
        try {
          detectionResultsRef.current = handLandmarkerRef.current.detectForVideo(
            videoRef.current, currentTime
          ) as { landmarks?: Array<Array<{ x: number; y: number; z: number }>> };
        } catch {
          detectionResultsRef.current = null;
        }
      } else {
        detectionResultsRef.current = null;
      }
      
      // Only update game physics when game is actually running (after countdown)
      // BUT in clicker mode, we need to process hands even during countdown
      if (isGameRunningRef.current || gameModeRef.current === 'clicker') {
        updateGame(deltaTime);
      }
      
      // Always draw webcam (even during countdown) so user can see their camera feed
      drawWebcam();
      
      // Always render the scene (to show countdown state)
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
      
      frameCountRef.current++;
      animationFrameRef.current = requestAnimationFrame(gameLoop);
    };
    
    gameLoop(performance.now());
  };

  const updateGame = (deltaTime: number) => {
    // In clicker mode, we don't need the 3D scene
    if (gameModeRef.current === 'race' && (!birdRef.current || !sceneRef.current || !cameraRef.current)) {
      return;
    }
    
    // Target 60 FPS as baseline (deltaTime will be ~0.0167 at 60fps)
    const timeScale = deltaTime * 60; // Normalize to 60 FPS
    
    // Always check for hand detection results first (before any condition)
    const results = detectionResultsRef.current;
    
    // Validate hand detection - check for sufficient landmarks (MediaPipe returns 21 landmarks for a complete hand)
    const hasValidHand = !!(results?.landmarks && results.landmarks.length > 0 && results.landmarks[0].length >= 16);
    
    console.log('🔍 Update Check:', {
      hasLandmarks: !!(results?.landmarks && results.landmarks.length > 0),
      numLandmarks: results?.landmarks?.[0]?.length || 0,
      hasValidHand,
      gameMode: gameModeRef.current,
      gameOverRef: gameOverRef.current,
      isGameRunningRef: isGameRunningRef.current
    });
    
    // Hand tracking for both modes (race needs game running, clicker doesn't)
    const shouldProcessHands = gameModeRef.current === 'clicker' ? !gameOverRef.current : (!gameOverRef.current && isGameRunningRef.current);
    
    console.log('✅ Should process hands:', shouldProcessHands, '| Valid hand:', hasValidHand);
    
    if (shouldProcessHands && hasValidHand && results?.landmarks) {
      const hand = results.landmarks[0];
      const wrist = hand[0];
      const handY = wrist.y;
      const handX = wrist.x;
      const now = Date.now();
      
      // Update state for UI indicator IMMEDIATELY
      setCurrentHandY(handY);
      
      // === FIST DETECTION (for cloud sabotage in race mode) ===
      // Check if all fingertips are curled toward palm (fist gesture)
      // Fingertips: 8(index), 12(middle), 16(ring), 20(pinky)
      // MCP joints: 5(index), 9(middle), 13(ring), 17(pinky)
      if (hand.length >= 21) {
        const fingertips = [hand[8], hand[12], hand[16], hand[20]];
        const mcpJoints = [hand[5], hand[9], hand[13], hand[17]];
        const isFist = fingertips.every((tip, i) => tip.y > mcpJoints[i].y);
        
        // Handle cloud sabotage: if popup is active and fist detected, throw cloud
        if (isFist && cloudSabotagePopupRef.current && gameModeRef.current === 'race') {
          console.log('👊 FIST DETECTED! Throwing cloud at opponent!');
          setCloudSabotagePopup(false);
          cloudSabotagePopupRef.current = false;
          if (socketRef.current && roomCodeRef.current) {
            socketRef.current.emit('throw-cloud', { roomCode: roomCodeRef.current });
          }
        }
        
        // Handle burnt cookie sabotage: if popup is active and fist detected, throw burnt cookie
        if (isFist && burntCookiePopupRef.current && gameModeRef.current === 'clicker') {
          console.log('👊 FIST! Throwing burnt cookie at opponent!');
          setBurntCookiePopup(false);
          burntCookiePopupRef.current = false;
          if (socketRef.current && roomCodeRef.current) {
            socketRef.current.emit('throw-burnt-cookie', { roomCode: roomCodeRef.current });
          }
        }
      }
      
      // === HORIZONTAL MOVEMENT TRACKING (for dough rolling + burnt cookie wiping) ===
      if (lastHandXRef.current !== null) {
        const deltaX = handX - lastHandXRef.current;
        
        // Dough rolling: track horizontal motion during dough phase
        if (doughPhaseActiveRef.current && Math.abs(deltaX) > HORIZONTAL_THRESHOLD) {
          horizontalRollCountRef.current++;
          const progress = Math.min(100, horizontalRollCountRef.current * 5);
          setDoughProgress(progress);
          
          // Award massive CPS bonus for rolling
          if (horizontalRollCountRef.current % 3 === 0) {
            setCookies(prev => {
              let totalCPS = 0;
              ownedUpgradesRef.current.forEach((count, upgradeId) => {
                const upgrade = UPGRADES.find(u => u.id === upgradeId);
                if (upgrade && upgrade.type === 'building' && upgrade.cps) {
                  totalCPS += upgrade.cps * count;
                }
              });
              const bonus = Math.max(5, totalCPS * 2);
              const newCookies = prev + bonus;
              setMyScore(newCookies);
              if (socketRef.current && roomCodeRef.current) {
                socketRef.current.emit('update-score', { roomCode: roomCodeRef.current, score: newCookies });
              }
              return newCookies;
            });
          }
          
          // Complete dough phase at 100%
          if (progress >= 100) {
            setDoughPhaseActive(false);
            doughPhaseActiveRef.current = false;
            setDoughProgress(0);
          }
        }
        
        // Burnt cookie wiping: horizontal wipe motion clears burnt cookie
        if (burntCookieActiveRef.current && Math.abs(deltaX) > WIPE_MOTION_THRESHOLD) {
          console.log('🧹 Wiped burnt cookie away!');
          setBurntCookieActive(false);
          burntCookieActiveRef.current = false;
        }
      }
      lastHandXRef.current = handX;
      
      // === VERTICAL MOVEMENT TRACKING (standard rep detection + dive) ===
      // Track directional movement (up = Y decreasing, down = Y increasing)
      if (lastHandYRef.current === null) {
        lastHandYRef.current = handY;
        peakHandYRef.current = handY;
        handPositionRef.current = null;
      } else {
        const deltaY = handY - lastHandYRef.current;
        
        if (peakHandYRef.current === null) {
          peakHandYRef.current = handY;
        }
        
        // === DIVE DETECTION (Flappy mode) ===
        // If downward deltaY exceeds DIVE_THRESHOLD in a single frame, trigger dive
        if (gameModeRef.current === 'race' && deltaY > DIVE_THRESHOLD && !diveActiveRef.current) {
          console.log('🦅 DIVE DETECTED! deltaY:', deltaY.toFixed(3));
          setDiveActive(true);
          diveActiveRef.current = true;
          // Clear any existing dive timer
          if (diveTimerRef.current) clearTimeout(diveTimerRef.current);
          diveTimerRef.current = setTimeout(() => {
            setDiveActive(false);
            diveActiveRef.current = false;
          }, DIVE_DURATION);
        }
        
        // Detect upward movement (Y decreasing)
        if (deltaY < -0.005) {
          if (handPositionRef.current === 'down' && peakHandYRef.current !== null && (peakHandYRef.current - handY) > MOVEMENT_THRESHOLD) {
            handPositionRef.current = 'up';
            peakHandYRef.current = handY;
          } else {
            peakHandYRef.current = Math.min(peakHandYRef.current, handY);
            if (handPositionRef.current === null) {
              handPositionRef.current = 'up';
            }
          }
        }
        // Detect downward movement (Y increasing)
        else if (deltaY > 0.005) {
          if (handPositionRef.current === 'up' && peakHandYRef.current !== null && (handY - peakHandYRef.current) > MOVEMENT_THRESHOLD) {
            const timeSinceLastRep = now - lastRepTimeRef.current;
            
            if (timeSinceLastRep >= MOVEMENT_COOLDOWN) {
              const movementMagnitude = handY - peakHandYRef.current;
              lastRepTimeRef.current = now;
              handPositionRef.current = 'down';
              peakHandYRef.current = handY;
              
              // === HEAT MULTIPLIER: track rep rhythm ===
              if (gameModeRef.current === 'clicker') {
                const timings = lastRepTimingsRef.current;
                timings.push(timeSinceLastRep);
                if (timings.length > 5) timings.shift(); // Keep last 5 timings
                
                // Check rhythm consistency
                if (timings.length >= 3) {
                  const avgTiming = timings.reduce((a, b) => a + b, 0) / timings.length;
                  const allInWindow = timings.every(t => Math.abs(t - avgTiming) / avgTiming <= HEAT_RHYTHM_WINDOW);
                  
                  if (allInWindow) {
                    setHeatMultiplier(prev => {
                      const newHeat = Math.min(MAX_HEAT_MULTIPLIER, prev + 0.2);
                      heatMultiplierRef.current = newHeat;
                      setCookieGlow(newHeat >= 1.5);
                      return newHeat;
                    });
                  } else {
                    setHeatMultiplier(prev => {
                      const newHeat = Math.max(1, prev - 0.3);
                      heatMultiplierRef.current = newHeat;
                      setCookieGlow(newHeat >= 1.5);
                      return newHeat;
                    });
                  }
                }
                
                // === MEGA COOKIE EVENT: check for large downward motion ===
                if (megaCookieEventRef.current && movementMagnitude > MEGA_COOKIE_MOTION_THRESHOLD) {
                  console.log('💥 MEGA COOKIE SMASH! Movement:', movementMagnitude.toFixed(3));
                  setMegaCookieEvent(false);
                  megaCookieEventRef.current = false;
                  
                  // Award 100x current click power
                  setCookies(prevCookies => {
                    let clickMultiplier = 1;
                    ownedUpgradesRef.current.forEach((count, upgradeId) => {
                      const upgrade = UPGRADES.find(u => u.id === upgradeId);
                      if (upgrade && upgrade.type === 'hand' && upgrade.multiplier) {
                        clickMultiplier *= upgrade.multiplier; // Hand upgrades stack multiplicatively
                      }
                    });
                    const megaBonus = Math.floor(clickMultiplier * 100);
                    const newCookies = prevCookies + megaBonus;
                    setMyScore(newCookies);
                    if (socketRef.current && roomCodeRef.current) {
                      socketRef.current.emit('update-score', { roomCode: roomCodeRef.current, score: newCookies });
                    }
                    return newCookies;
                  });
                }
              }
              
              // Count the rep (skip if in dough phase - dough phase uses horizontal motion)
              if (gameModeRef.current === 'clicker' && !doughPhaseActiveRef.current) {
                setClickCount(prev => prev + 1);
                
                // Calculate cookies earned (with heat multiplier and burnt cookie penalty)
                setCookies(prevCookies => {
                  let multiplier = 1;
                  ownedUpgradesRef.current.forEach((count, upgradeId) => {
                    const upgrade = UPGRADES.find(u => u.id === upgradeId);
                    if (upgrade && upgrade.type === 'hand' && upgrade.multiplier) {
                      multiplier *= upgrade.multiplier; // Hand upgrades stack multiplicatively
                    }
                  });
                  
                  // Apply heat multiplier
                  multiplier *= heatMultiplierRef.current;
                  
                  // Apply burnt cookie penalty
                  if (burntCookieActiveRef.current) {
                    multiplier *= 0.5;
                  }
                  
                  const cookiesEarned = Math.floor(multiplier);
                  const newCookies = prevCookies + cookiesEarned;
                  
                  setMyScore(newCookies);
                  if (socketRef.current && roomCodeRef.current) {
                    socketRef.current.emit('update-score', { 
                      roomCode: roomCodeRef.current, 
                      score: newCookies 
                    });
                  }
                  
                  const crumbleId = Date.now();
                  setCookieCrumbles(prev => [...prev, { id: crumbleId, x: wrist.x, y: wrist.y }]);
                  setTimeout(() => {
                    setCookieCrumbles(prev => prev.filter(c => c.id !== crumbleId));
                  }, 1000);
                  
                  return newCookies;
                });
              } else if (gameModeRef.current === 'race') {
                birdVelocityRef.current = flapStrengthRef.current;
              }
            }
          } else {
            peakHandYRef.current = Math.max(peakHandYRef.current, handY);
            if (handPositionRef.current === null) {
              handPositionRef.current = 'down';
            }
          }
        }
      }
      
      lastHandYRef.current = handY;
    } else {
      if (!shouldProcessHands) {
        console.log('⏸️ Hand processing paused (game state)');
      } else if (!hasValidHand) {
        console.log('❌ No valid hand detected (need 16+ landmarks, got', results?.landmarks?.[0]?.length || 0, ')');
      }
      // Don't immediately set to null - keep showing last valid position for smoother UI
      // Only set to null if no detection for extended period
      if (!results?.landmarks || results.landmarks.length === 0) {
        setCurrentHandY(null);
      }
    }
    
    // Only process player physics and input if player is alive AND game is running
    if (!gameOverRef.current && isGameRunningRef.current) {
      
      // Bird physics - only in race mode
      if (gameModeRef.current === 'race' && birdRef.current) {
        // Apply dive modifier: double gravity when dive is active
        const gravityMultiplier = diveActiveRef.current ? 2.0 : 1.0;
        birdVelocityRef.current += gravityRef.current * gravityMultiplier * timeScale;
        birdYRef.current += birdVelocityRef.current * 0.01 * timeScale;
        birdRef.current.position.y = birdYRef.current;
        birdRef.current.rotation.x = Math.max(-0.5, Math.min(0.5, -birdVelocityRef.current * 0.05));
      }
    } else if (gameOverRef.current && gameModeRef.current === 'race' && birdRef.current) {
      // Death animation - make bird fall and fade
      birdVelocityRef.current += gravityRef.current * 1.5 * timeScale; // Fall faster when dead
      birdYRef.current += birdVelocityRef.current * 0.01 * timeScale;
      birdRef.current.position.y = birdYRef.current;
      birdRef.current.rotation.z += 0.05 * timeScale; // Spin while falling
      
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
    
    // Position bird horizontally based on player index - RACE MODE ONLY
    if (gameMode === 'race' && birdRef.current) {
      const playerIndex = players.findIndex(p => p.id === myPlayerId);
      const numPlayers = players.length;
      const spacing = 6; // Spacing between birds on X axis
      const totalWidth = (numPlayers - 1) * spacing;
      const xOffset = playerIndex * spacing - totalWidth / 2;
      birdRef.current.position.x = xOffset;
      birdRef.current.position.z = 0; // Keep all birds at same depth
    }
    
    // Ensure bird stays at Y=0 during countdown (when game not running) - RACE MODE ONLY
    if (!isGameRunningRef.current && !gameOverRef.current && gameMode === 'race' && birdRef.current) {
      birdRef.current.position.y = 0;
      birdYRef.current = 0;
      birdVelocityRef.current = 0;
    }
    
    // Update opponent birds positions with interpolation for smooth movement - RACE MODE ONLY
    if (gameMode === 'race') {
      const numPlayers = players.length;
      const spacing = 6;
      const totalWidth = (numPlayers - 1) * spacing;
      
      opponentBirdsRef.current.forEach((opponent, playerId) => {
        const opponentIndex = players.findIndex(p => p.id === playerId);
        const opponentXOffset = opponentIndex * spacing - totalWidth / 2;
        
        // Smooth interpolation for Y position (lerp with factor 0.3 for responsiveness)
        opponent.y += (opponent.targetY - opponent.y) * 0.3;
        opponent.mesh.position.set(opponentXOffset, opponent.y, 0); // All birds at same depth
      });
    }
    
    // Camera follow - always track something - RACE MODE ONLY
    if (gameMode === 'race' && cameraRef.current) {
      const playerIndex = players.findIndex(p => p.id === myPlayerId);
      const numPlayers = players.length;
      const spacing = 6;
      const totalWidth = (numPlayers - 1) * spacing;
      const xOffset = playerIndex * spacing - totalWidth / 2;
      
      if (gameOverRef.current && alivePlayers.size >= 1) {
      // Spectate alive players when dead
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
        const lerpFactor = 0.05 * timeScale;
        cameraRef.current.position.y += (avgY - cameraRef.current.position.y) * lerpFactor;
        cameraRef.current.position.x += (avgX - cameraRef.current.position.x) * lerpFactor;
        cameraRef.current.lookAt(avgX, avgY, 0);
      }
    } else {
      // Follow player (alive or dead but no one else alive)
      const lerpFactor = 0.08 * timeScale;
      cameraRef.current.position.y += (birdYRef.current - cameraRef.current.position.y) * lerpFactor;
      cameraRef.current.position.x += (xOffset - cameraRef.current.position.x) * lerpFactor;
      cameraRef.current.lookAt(xOffset, birdYRef.current, 0);
      spectatingRef.current = gameOverRef.current && alivePlayers.size > 0;
      }
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
    if (isGameRunningRef.current && gameMode === 'race') {
      // Bounds check (only for alive players in race mode)
      if (!gameOverRef.current) {
        if (birdYRef.current > CEILING_LEVEL - 0.8 || birdYRef.current < GROUND_LEVEL + 0.8) {
          gameOverRef.current = true;
          setIsDead(true);
          if (socketRef.current && roomCodeRef.current) {
            socketRef.current.emit('player-died', { roomCode: roomCodeRef.current });
          }
        }
      }
      
      // Calculate deterministic elapsed time from authoritative server-synchronized game start
      // Guard against uninitialized game start time (prevents pipes jumping on second tower)
      const elapsedGameTimeMs = gameStartTimeRef.current > 0 ? Date.now() - gameStartTimeRef.current : 0;
      const elapsedGameTimeSec = elapsedGameTimeMs / 1000;
      
      // Pipe reveal logic - synchronized across all clients based on game time
      if (isRoomCreatorRef.current && socketRef.current && roomCodeRef.current) {
        const pipesToReveal = Math.floor(elapsedGameTimeSec / 0.67); // Reveal one pipe every 0.67 seconds
        
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
      
      // Calculate player position offset for pipes
      const playerIndex = players.findIndex(p => p.id === myPlayerId);
      const numPlayers = players.length;
      const spacing = 6;
      const totalWidth = (numPlayers - 1) * spacing;
      const xOffset = playerIndex * spacing - totalWidth / 2;
      
      // Update pipes - using DETERMINISTIC position calculation (no accumulation)
      // ALL clients calculate the exact same position based on elapsed game time
      for (let i = pipesRef.current.length - 1; i >= 0; i--) {
        const pipe = pipesRef.current[i];
        
        // Use the stored initialZ instead of calculating from array index
        // This prevents position jumps when pipes are removed from the array
        const travelDistance = pipeSpeedRef.current * elapsedGameTimeSec * 60; // Normalize to 60 FPS equivalent
        pipe.z = pipe.initialZ + travelDistance;
        
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
        if (!gameOverRef.current && pipe.z > -2.5 && pipe.z < 2.5 && birdRef.current) {
          const BIRD_RADIUS = 0.8;
          const birdX = birdRef.current.position.x;
          const birdY = birdYRef.current;
          const pipeX = pipe.bottom.position.x;
          
          // Check if bird is within pipe's X bounds (accounting for bird radius)
          const isInPipeXRange = Math.abs(birdX - pipeX) < pipe.width / 2 + BIRD_RADIUS;
          
          // Check if bird is outside the gap vertically (accounting for bird radius)
          const isOutsideGap = birdY < pipe.gapY - pipeGapRef.current / 2 + BIRD_RADIUS || 
                               birdY > pipe.gapY + pipeGapRef.current / 2 - BIRD_RADIUS;
          
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
    
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return; // Video dimensions not yet available
    
    // Ensure canvas buffer matches video dimensions exactly
    if (canvas.width !== vw || canvas.height !== vh) {
      canvas.width = vw;
      canvas.height = vh;
    }
    
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Draw mirrored video - use canvas dimensions to fill entire canvas
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
    ctx.restore();
    
    // Draw hand landmarks from cached detection results (detected once per frame in game loop)
    const results = detectionResultsRef.current;
    if (results?.landmarks && results.landmarks.length > 0) {
      const hand = results.landmarks[0];
      const wrist = hand[0];
      
      // Always log to see actual values
      console.log('🖐️ Wrist raw:', wrist.x.toFixed(3), wrist.y.toFixed(3), wrist.z?.toFixed(3));
      console.log('🖐️ Canvas dims:', canvas.width, 'x', canvas.height);
      console.log('🖐️ Calculated pixel:', Math.round(canvas.width - wrist.x * canvas.width), ',', Math.round(wrist.y * canvas.height));
      
      ctx.fillStyle = '#00f5ff';
      ctx.strokeStyle = '#00f5ff';
      ctx.lineWidth = 1;
      
      // MediaPipe landmarks are normalized (0-1) relative to the video feed
      // Scale to canvas dimensions and mirror X to match the mirrored video
      const dotRadius = Math.max(2, Math.round(canvas.width / 160));
      hand.forEach((landmark) => {
        const x = canvas.width - (landmark.x * canvas.width);
        const y = landmark.y * canvas.height;
        
        ctx.beginPath();
        ctx.arc(x, y, dotRadius, 0, 2 * Math.PI);
        ctx.fill();
      });
    }
    
    // Draw cookie crumbles animation
    if (gameModeRef.current === 'clicker' && cookieCrumbles.length > 0) {
      cookieCrumbles.forEach(crumble => {
        const x = canvas.width - (crumble.x * canvas.width);
        const y = crumble.y * canvas.height;
        
        // Draw multiple cookie crumbs spreading out
        ctx.fillStyle = '#D2691E';
        for (let i = 0; i < 8; i++) {
          const angle = (i / 8) * Math.PI * 2;
          const distance = 20 + Math.random() * 30;
          const crumbX = x + Math.cos(angle) * distance;
          const crumbY = y + Math.sin(angle) * distance;
          const size = 3 + Math.random() * 5;
          
          ctx.beginPath();
          ctx.arc(crumbX, crumbY, size, 0, 2 * Math.PI);
          ctx.fill();
        }
        
        // Draw cookie emoji at center
        ctx.font = '40px Arial';
        ctx.fillText('🍪', x - 20, y + 15);
      });
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
    socketRef.current.emit('create-room', { playerName, difficulty, gameMode });
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
          Motion Games
        </h1>
        <p className="text-xl text-gray-400 mb-12">Hand-tracking multiplayer games!</p>
        
        <div className="max-w-2xl w-full flex gap-8">
          {/* Left: Game Settings */}
          <div className="flex-1 space-y-6">
            <input
              type="text"
              placeholder="Enter your name"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              className="w-full px-4 py-3 bg-gray-900 border-2 border-cyan-500 rounded-lg text-white focus:outline-none focus:border-pink-500"
            />
            
            <div>
              <label className="block text-sm text-gray-400 mb-2">Game Mode</label>
              <div className="space-y-2">
                <button
                  onClick={() => { setGameMode('race'); setHoveredMode('race'); }}
                  onMouseEnter={() => setHoveredMode('race')}
                  className={`w-full px-4 py-3 rounded-lg text-left font-bold transition-all ${
                    gameMode === 'race' 
                      ? 'bg-cyan-600 border-2 border-cyan-300 text-white' 
                      : 'bg-gray-900 border-2 border-gray-700 text-gray-300 hover:border-cyan-500'
                  }`}
                >
                  🐦 Flappy Bird Race
                </button>
                <button
                  onClick={() => { setGameMode('clicker'); setHoveredMode('clicker'); }}
                  onMouseEnter={() => setHoveredMode('clicker')}
                  className={`w-full px-4 py-3 rounded-lg text-left font-bold transition-all ${
                    gameMode === 'clicker' 
                      ? 'bg-pink-600 border-2 border-pink-300 text-white' 
                      : 'bg-gray-900 border-2 border-gray-700 text-gray-300 hover:border-pink-500'
                  }`}
                >
                  🍪 Cookie Clicker
                </button>
              </div>
            </div>
            
            <div>
              {gameMode === 'race' ? (
                <>
                  <label className="block text-sm text-gray-400 mb-2">Difficulty</label>
                  <select
                    value={difficulty}
                    onChange={(e) => {
                      const newDiff = e.target.value as Difficulty;
                      setDifficulty(newDiff);
                      difficultyRef.current = newDiff;
                    }}
                    className="w-full px-4 py-3 bg-gray-900 border-2 border-cyan-500 rounded-lg text-white focus:outline-none"
                  >
                    <option value="easy">Easy (Green Pipes)</option>
                    <option value="medium">Medium (Yellow Pipes)</option>
                    <option value="hard">Hard (Red Pipes)</option>
                  </select>
                </>
              ) : (
                <>
                  <label className="block text-sm text-gray-400 mb-2">Time Limit</label>
                  <select
                    value={timeLimit}
                    onChange={(e) => setTimeLimit(Number(e.target.value) as TimeLimit)}
                    className="w-full px-4 py-3 bg-gray-900 border-2 border-pink-500 rounded-lg text-white focus:outline-none"
                  >
                    <option value="0">Unlimited</option>
                    <option value="120">2 Minutes</option>
                    <option value="300">5 Minutes</option>
                    <option value="600">10 Minutes</option>
                  </select>
                </>
              )}
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
          
          {/* Right: How to Play description */}
          <div className="flex-1">
            <div className="bg-gray-900 border-2 border-gray-700 rounded-lg p-6 h-full">
              <h2 className="text-xl font-bold mb-4 text-cyan-400">📖 How to Play</h2>
              {(hoveredMode || gameMode) === 'race' ? (
                <div className="space-y-3 text-sm">
                  <p className="text-white font-bold text-lg">🐦 Flappy Bird Race</p>
                  <div className="border-l-2 border-cyan-500 pl-3">
                    <p className="text-gray-300 mb-1"><strong>Flap:</strong> Move hand up then down to flap</p>
                    <p className="text-gray-300 mb-1"><strong>Dive:</strong> Fast downward hand flick for rapid descent</p>
                    <p className="text-gray-300 mb-1"><strong>Sabotage:</strong> Make a FIST when prompted to throw clouds at opponents!</p>
                  </div>
                  <div className="mt-4 p-3 bg-gray-800 rounded-lg">
                    <p className="text-yellow-400 text-xs font-bold">SPECIAL MECHANICS</p>
                    <p className="text-gray-400 text-xs mt-1">⚡ Dive through tight gaps with the fast-flick mechanic</p>
                    <p className="text-gray-400 text-xs">☁️ Throw clouds to block opponents&apos; view for 3 seconds</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3 text-sm">
                  <p className="text-white font-bold text-lg">🍪 Cookie Clicker</p>
                  <div className="border-l-2 border-pink-500 pl-3">
                    <p className="text-gray-300 mb-1"><strong>Click:</strong> Move hand up then down to earn cookies</p>
                    <p className="text-gray-300 mb-1"><strong>Smash:</strong> Large downward motion during MEGA COOKIE event for 100x bonus</p>
                    <p className="text-gray-300 mb-1"><strong>Roll:</strong> Move hand left/right during Dough Phase for massive CPS</p>
                    <p className="text-gray-300 mb-1"><strong>Wipe:</strong> Horizontal swipe to clear Burnt Cookies</p>
                  </div>
                  <div className="mt-4 p-3 bg-gray-800 rounded-lg">
                    <p className="text-yellow-400 text-xs font-bold">SPECIAL MECHANICS</p>
                    <p className="text-gray-400 text-xs mt-1">🔥 Keep a rhythm for Heat Multiplier (up to 3x!)</p>
                    <p className="text-gray-400 text-xs">💥 MEGA COOKIE: Smash for 100x Click-Power</p>
                    <p className="text-gray-400 text-xs">🫘 Dough Phase: Roll left/right for bonus cookies</p>
                    <p className="text-gray-400 text-xs">🔥 Throw Burnt Cookies to halve opponent&apos;s CPS</p>
                  </div>
                </div>
              )}
            </div>
          </div>
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
      <video ref={videoRef} autoPlay playsInline style={{ position: 'absolute', left: '-9999px', width: '480px', height: '480px' }} />
      
      {/* === IN-GAME HUD CONTROLS === */}
      <div className="absolute top-0 left-0 right-0 z-30 flex justify-center pointer-events-none">
        <div className="mt-2 px-6 py-2 rounded-b-lg text-center" style={{
          background: 'rgba(0, 0, 0, 0.55)',
          backdropFilter: 'blur(8px)',
          border: '1px solid rgba(0, 245, 255, 0.3)',
          borderTop: 'none'
        }}>
          {gameMode === 'race' ? (
            <p className="text-sm text-cyan-300 font-mono">
              <span className="text-white font-bold">Flap</span> (Hand Up/Down)
              <span className="mx-2 text-gray-500">|</span>
              <span className="text-white font-bold">Dive</span> (Fast Downward Flick)
              {diveActive && <span className="ml-2 text-red-400 animate-pulse font-bold">⚡ DIVING</span>}
            </p>
          ) : (
            <p className="text-sm text-pink-300 font-mono">
              <span className="text-white font-bold">Click</span> (Hand Up/Down)
              <span className="mx-2 text-gray-500">|</span>
              <span className="text-white font-bold">Smash</span> (Large Downward Motion)
              <span className="mx-2 text-gray-500">|</span>
              <span className="text-white font-bold">Roll</span> (Left/Right)
              {remainingTime !== null && remainingTime > 0 && (
                <span className="ml-2 text-yellow-400 font-bold">
                  ⏱️ {Math.floor(remainingTime / 60)}:{(remainingTime % 60).toString().padStart(2, '0')}
                </span>
              )}
              {heatMultiplier > 1 && (
                <span className="ml-2 text-orange-400 font-bold">🔥 {heatMultiplier.toFixed(1)}x Heat</span>
              )}
            </p>
          )}
        </div>
      </div>
      
      {/* Game Canvas - Only for race mode */}
      {gameMode === 'race' && (
        <div ref={containerRef} className="border-4 border-cyan-500" style={{ boxShadow: '0 0 30px rgba(0, 245, 255, 0.5)' }} />
      )}
      
      {/* Clicker Mode UI */}
      {gameMode === 'clicker' && (
        <div className="flex flex-col items-center justify-center">
          <div className="text-center mb-8">
            <h1 className="text-6xl font-bold mb-4" style={{ textShadow: '0 0 20px #00f5ff' }}>
              {doughPhaseActive ? '🫘 Rolling Dough!' : '🍪 Cookie Clicker'}
            </h1>
            {remainingTime !== null && remainingTime > 0 && (
              <div className="text-4xl font-bold text-yellow-400 mb-2">
                ⏱️ {Math.floor(remainingTime / 60)}:{(remainingTime % 60).toString().padStart(2, '0')}
              </div>
            )}
            <p className="text-3xl text-cyan-400 mb-2">
              {doughPhaseActive ? 'Move hand LEFT/RIGHT to roll!' : 'Move your hand up & down to click!'}
            </p>
          </div>
          
          <div className="bg-gray-900 border-4 rounded-lg p-12 mb-8 relative" style={{
            borderColor: cookieGlow ? '#ff6600' : '#06b6d4',
            boxShadow: cookieGlow 
              ? '0 0 40px rgba(255, 102, 0, 0.7), 0 0 80px rgba(255, 60, 0, 0.3)' 
              : '0 0 30px rgba(0, 245, 255, 0.5)',
            transition: 'border-color 0.3s, box-shadow 0.3s'
          }}>
            <div className="text-center">
              {/* Cookie / Dough display */}
              {doughPhaseActive ? (
                <div>
                  <div className="text-9xl mb-4">🫘</div>
                  <div className="w-full bg-gray-700 rounded-full h-6 mb-4">
                    <div 
                      className="h-6 rounded-full transition-all duration-200" 
                      style={{ 
                        width: `${doughProgress}%`, 
                        background: 'linear-gradient(to right, #f59e0b, #ef4444)' 
                      }}
                    />
                  </div>
                  <p className="text-2xl text-yellow-400 font-bold">{doughProgress}% Rolled</p>
                </div>
              ) : (
                <div className="text-9xl mb-4" style={{
                  filter: cookieGlow ? 'drop-shadow(0 0 20px rgba(255, 100, 0, 0.8))' : 'none',
                  animation: cookieGlow ? 'pulse 0.5s infinite' : megaCookieEvent ? 'pulse 0.3s infinite' : 'pulse 2s infinite',
                  transform: megaCookieEvent ? 'scale(1.3)' : 'scale(1)',
                  transition: 'transform 0.3s'
                }}>
                  {megaCookieEvent ? '🌟' : '🍪'}
                </div>
              )}
              <p className="text-6xl font-bold text-cyan-400 mb-2">{Math.floor(cookies)}</p>
              <p className="text-2xl text-gray-400 mb-2">Cookies</p>
              
              {/* Heat Multiplier Bar */}
              {heatMultiplier > 1 && (
                <div className="mb-2">
                  <div className="flex items-center justify-center gap-2">
                    <span className="text-orange-400 font-bold">🔥 HEAT</span>
                    <div className="w-32 bg-gray-700 rounded-full h-3">
                      <div 
                        className="h-3 rounded-full transition-all duration-300"
                        style={{ 
                          width: `${((heatMultiplier - 1) / (MAX_HEAT_MULTIPLIER - 1)) * 100}%`,
                          background: `linear-gradient(to right, #f59e0b, #ef4444)`
                        }}
                      />
                    </div>
                    <span className="text-orange-300 font-bold text-sm">{heatMultiplier.toFixed(1)}x</span>
                  </div>
                </div>
              )}
              
              <p className="text-3xl text-yellow-400 font-bold">
                {(() => {
                  let totalCPS = 0;
                  ownedUpgrades.forEach((count, upgradeId) => {
                    const upgrade = UPGRADES.find(u => u.id === upgradeId);
                    if (upgrade && upgrade.type === 'building' && upgrade.cps) {
                      totalCPS += upgrade.cps * count;
                    }
                  });
                  if (burntCookieActive) totalCPS *= 0.5;
                  return Math.floor(totalCPS);
                })()} CPS
                {burntCookieActive && <span className="text-red-400 text-lg ml-2">(🔥 Burnt! -50%)</span>}
              </p>
              
              {/* Hand Position Indicator */}
              <div className="mt-4 pt-4 border-t border-gray-700">
                <p className="text-sm text-gray-500 mb-1">Hand Tracking Status</p>
                <p className="text-2xl font-bold">
                  {currentHandY !== null ? (
                    <span className="text-green-400">✅ Tracking</span>
                  ) : (
                    <span className="text-red-400">❌ Not Detected</span>
                  )}
                </p>
              </div>
            </div>
          </div>

          {/* Shop and Upgrades Buttons */}
          <div className="flex gap-4 mb-4">
            <button
              onClick={() => setShowShop(true)}
              className="px-8 py-4 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 text-white font-bold rounded-lg transition-all text-2xl"
              style={{ boxShadow: '0 0 20px rgba(34, 197, 94, 0.5)' }}
            >
              🏪 Shop
            </button>
            <button
              onClick={() => setShowUpgrades(true)}
              className="px-8 py-4 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white font-bold rounded-lg transition-all text-2xl"
              style={{ boxShadow: '0 0 20px rgba(168, 85, 247, 0.5)' }}
            >
              📦 My Upgrades
            </button>
          </div>
        </div>
      )}

      {/* Shop Modal - Cookie Clicker */}
      {showShop && gameMode === 'clicker' && (
        <div className="absolute inset-0 bg-black bg-opacity-90 flex items-center justify-center z-60 p-8">
          <div className="bg-gray-900 border-4 border-green-500 rounded-lg p-8 max-w-4xl max-h-[80vh] overflow-y-auto relative" style={{ boxShadow: '0 0 40px rgba(34, 197, 94, 0.7)' }}>
            <button
              onClick={() => setShowShop(false)}
              className="absolute top-4 right-4 text-4xl text-white hover:text-red-500 transition-colors"
            >
              ×
            </button>
            <h2 className="text-5xl font-bold mb-6 text-green-400 text-center">🏪 Cookie Shop</h2>
            <div className="mb-4 text-center">
              <p className="text-xl text-yellow-400 font-bold">Your Total Worth: 🍪 {Math.floor(cookies)}</p>
            </div>
            
            {/* Hand Upgrades Section */}
            <div className="mb-8">
              <h3 className="text-3xl font-bold mb-4 text-cyan-400">👋 Hand Upgrades (One-Time)</h3>
              <div className="grid grid-cols-1 gap-4">
                {UPGRADES.filter(u => u.type === 'hand').map((upgrade) => {
                  const owned = ownedUpgrades.get(upgrade.id) || 0;
                  const alreadyOwned = owned > 0;
                  const cost = upgrade.baseCost;
                  const canAfford = cookies >= cost && !alreadyOwned;
                  
                  return (
                    <div
                      key={upgrade.id}
                      className={`bg-gray-800 border-2 rounded-lg p-4 flex items-center justify-between ${
                        alreadyOwned ? 'border-green-400 bg-green-900 bg-opacity-20' :
                        canAfford ? 'border-cyan-400' : 'border-gray-600 opacity-50'
                      }`}
                    >
                      <div className="flex items-center gap-4">
                        <span className="text-5xl">{upgrade.icon}</span>
                        <div>
                          <p className="text-2xl font-bold text-white">{upgrade.name}</p>
                          <p className="text-lg text-gray-400">{upgrade.description}</p>
                          {alreadyOwned && (
                            <p className="text-sm text-green-400 font-bold">✓ OWNED</p>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          if (canAfford) {
                            setCookies(prev => prev - cost);
                            setOwnedUpgrades(prev => {
                              const newMap = new Map(prev);
                              newMap.set(upgrade.id, 1);
                              return newMap;
                            });
                          }
                        }}
                        disabled={!canAfford || alreadyOwned}
                        className={`px-6 py-3 rounded-lg font-bold text-xl transition-all ${
                          alreadyOwned ? 'bg-gray-700 text-gray-500 cursor-not-allowed' :
                          canAfford
                            ? 'bg-cyan-600 hover:bg-cyan-500 text-white cursor-pointer'
                            : 'bg-gray-700 text-gray-500 cursor-not-allowed'
                        }`}
                      >
                        {alreadyOwned ? '✓' : `🍪 ${cost.toLocaleString()}`}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
            
            {/* Building Upgrades Section */}
            <div>
              <h3 className="text-3xl font-bold mb-4 text-pink-400">🏢 Buildings (Cookie Production)</h3>
              <div className="grid grid-cols-1 gap-4">
                {UPGRADES.filter(u => u.type === 'building').map((upgrade) => {
                  const owned = ownedUpgrades.get(upgrade.id) || 0;
                  const cost = Math.floor(upgrade.baseCost * Math.pow(1.15, owned));
                  const canAfford = cookies >= cost;
                  const isUnlocked = cookies >= (upgrade.requiredNetWorth || 0);
                  
                  return (
                    <div
                      key={upgrade.id}
                      className={`bg-gray-800 border-2 rounded-lg p-4 flex items-center justify-between ${
                        !isUnlocked ? 'border-gray-700 opacity-30' :
                        canAfford ? 'border-pink-400' : 'border-gray-600 opacity-50'
                      }`}
                    >
                      <div className="flex items-center gap-4">
                        <span className="text-5xl">{upgrade.icon}</span>
                        <div>
                          <p className="text-2xl font-bold text-white">{upgrade.name}</p>
                          <p className="text-lg text-gray-400">{upgrade.description}</p>
                          {!isUnlocked && upgrade.requiredNetWorth && (
                            <p className="text-sm text-red-400">🔒 Unlock at {upgrade.requiredNetWorth.toLocaleString()} cookies</p>
                          )}
                          {owned > 0 && (
                            <p className="text-sm text-cyan-400">Owned: {owned} | Total: +{(upgrade.cps! * owned).toFixed(1)}/sec</p>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          if (canAfford && isUnlocked) {
                            setCookies(prev => prev - cost);
                            setOwnedUpgrades(prev => {
                              const newMap = new Map(prev);
                              newMap.set(upgrade.id, (newMap.get(upgrade.id) || 0) + 1);
                              return newMap;
                            });
                          }
                        }}
                        disabled={!canAfford || !isUnlocked}
                        className={`px-6 py-3 rounded-lg font-bold text-xl transition-all ${
                          !isUnlocked ? 'bg-gray-700 text-gray-500 cursor-not-allowed' :
                          canAfford
                            ? 'bg-pink-600 hover:bg-pink-500 text-white cursor-pointer'
                            : 'bg-gray-700 text-gray-500 cursor-not-allowed'
                        }`}
                      >
                        🍪 {cost.toLocaleString()}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* My Upgrades Modal - Cookie Clicker */}
      {showUpgrades && gameMode === 'clicker' && (
        <div className="absolute inset-0 bg-black bg-opacity-90 flex items-center justify-center z-60 p-8">
          <div className="bg-gray-900 border-4 border-purple-500 rounded-lg p-8 max-w-4xl max-h-[80vh] overflow-y-auto relative" style={{ boxShadow: '0 0 40px rgba(168, 85, 247, 0.7)' }}>
            <button
              onClick={() => setShowUpgrades(false)}
              className="absolute top-4 right-4 text-4xl text-white hover:text-red-500 transition-colors"
            >
              ×
            </button>
            <h2 className="text-5xl font-bold mb-6 text-purple-400 text-center">📦 My Upgrades</h2>
            {ownedUpgrades.size === 0 ? (
              <p className="text-2xl text-gray-400 text-center py-8">You don&apos;t own any upgrades yet!</p>
            ) : (
              <div className="grid grid-cols-1 gap-4">
                {Array.from(ownedUpgrades.entries()).map(([upgradeId, count]) => {
                  const upgrade = UPGRADES.find(u => u.id === upgradeId);
                  if (!upgrade) return null;
                  
                  let effectText = '';
                  if (upgrade.type === 'hand' && upgrade.multiplier) {
                    effectText = `${upgrade.multiplier}x cookies per click`;
                  } else if (upgrade.type === 'building' && upgrade.cps) {
                    const totalCPS = upgrade.cps * count;
                    effectText = `+${totalCPS.toFixed(1)} cookies/sec`;
                  }
                  
                  return (
                    <div
                      key={upgradeId}
                      className="bg-gray-800 border-2 border-purple-400 rounded-lg p-4 flex items-center justify-between"
                    >
                      <div className="flex items-center gap-4">
                        <span className="text-5xl">{upgrade.icon}</span>
                        <div>
                          <p className="text-2xl font-bold text-white">{upgrade.name}</p>
                          <p className="text-lg text-purple-300">{effectText}</p>
                          <p className="text-sm text-cyan-400">Owned: {count}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
      
      {/* Webcam Corner View */}
      <div className="absolute top-4 right-4 z-50">
        <div className="border-4 border-pink-500 rounded-lg overflow-hidden" style={{ boxShadow: '0 0 20px rgba(255, 105, 180, 0.5)' }}>
          <canvas ref={webcamCanvasRef} style={{ display: 'block' }} />
        </div>
        <p className="text-center text-white mt-2 text-sm font-bold">Your Camera</p>
      </div>
      
      {/* Scoreboard */}
      <div className="absolute top-4 left-4 bg-black bg-opacity-80 px-4 py-3 rounded-lg border-2 border-cyan-500 z-20">
        {gameMode === 'clicker' && (
          <>
            <p className="text-2xl font-bold text-cyan-400 mb-2">🍪 Cookie Clicker Mode</p>
            <p className="text-xl text-yellow-400 font-bold mb-2">
              CPS: {(() => {
                let totalCPS = 0;
                ownedUpgrades.forEach((count, upgradeId) => {
                  const upgrade = UPGRADES.find(u => u.id === upgradeId);
                  if (upgrade && upgrade.type === 'building' && upgrade.cps) {
                    totalCPS += upgrade.cps * count;
                  }
                });
                return totalCPS.toFixed(1);
              })()}
            </p>
          </>
        )}
        {players.map((player) => (
          <p key={player.id} className="text-xl font-bold" style={{ color: player.id === myPlayerId ? '#00f5ff' : '#ffffff' }}>
            {player.name}: {player.score}
            {player.id === myPlayerId && ' (You)'}
          </p>
        ))}
        {gameMode === 'clicker' && myPlayerId && (
          <>
            <p className="text-lg text-cyan-300 mt-2">Cookies: {Math.floor(cookies)}</p>
            <p className="text-md text-gray-400">Clicks: {clickCount}</p>
          </>
        )}
      </div>
      
      
      {/* Countdown Overlay */}
      {countdown !== null && (
        <div className="absolute inset-0 bg-black bg-opacity-20 flex items-center justify-center z-50">
          <h1 className="text-9xl font-bold text-white animate-pulse" style={{ textShadow: '0 0 40px #00f5ff' }}>
            {countdown === 0 ? 'GO!' : countdown}
          </h1>
        </div>
      )}
      
      {/* Death Indicator - Only for race mode */}
      {isDead && gameMode === 'race' && (
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
      
      {/* === CLOUD INTERFERENCE OVERLAY (Flappy Bird) === */}
      {cloudOnScreen && (
        <div className="absolute inset-0 z-40 pointer-events-none flex items-center justify-center" style={{ animation: 'fadeIn 0.3s' }}>
          {/* SVG Cloud that obscures part of the screen */}
          <svg width="100%" height="100%" viewBox="0 0 800 600" style={{ opacity: 0.85 }}>
            <defs>
              <filter id="cloudBlur">
                <feGaussianBlur in="SourceGraphic" stdDeviation="3" />
              </filter>
            </defs>
            <g filter="url(#cloudBlur)">
              <ellipse cx="400" cy="200" rx="300" ry="120" fill="white" opacity="0.9" />
              <ellipse cx="300" cy="180" rx="150" ry="100" fill="white" opacity="0.9" />
              <ellipse cx="500" cy="180" rx="160" ry="90" fill="white" opacity="0.9" />
              <ellipse cx="350" cy="280" rx="250" ry="80" fill="white" opacity="0.85" />
              <ellipse cx="400" cy="350" rx="200" ry="60" fill="white" opacity="0.7" />
            </g>
          </svg>
          <p className="absolute top-1/2 text-4xl font-bold text-gray-700 animate-pulse" style={{ textShadow: '0 0 10px white' }}>
            ☁️ CLOUD ATTACK! ☁️
          </p>
        </div>
      )}
      
      {/* === CLOUD SABOTAGE POPUP (Flappy Bird) === */}
      {cloudSabotagePopup && gameMode === 'race' && (
        <div className="absolute bottom-32 left-1/2 transform -translate-x-1/2 z-50 animate-bounce">
          <div className="bg-gradient-to-r from-blue-600 to-indigo-600 border-4 border-white rounded-2xl px-8 py-6 text-center" 
               style={{ boxShadow: '0 0 40px rgba(99, 102, 241, 0.8)' }}>
            <p className="text-3xl font-bold text-white mb-2">☁️ QUICK!</p>
            <p className="text-xl text-blue-200">Make a <span className="text-yellow-300 font-bold">FIST</span> to throw a Cloud!</p>
            <p className="text-sm text-blue-300 mt-2 animate-pulse">👊 Close your hand NOW!</p>
          </div>
        </div>
      )}
      
      {/* === MEGA COOKIE EVENT POPUP === */}
      {megaCookieEvent && gameMode === 'clicker' && (
        <div className="absolute bottom-32 left-1/2 transform -translate-x-1/2 z-50 animate-bounce">
          <div className="bg-gradient-to-r from-yellow-500 to-red-500 border-4 border-yellow-300 rounded-2xl px-8 py-6 text-center"
               style={{ boxShadow: '0 0 60px rgba(234, 179, 8, 0.9)' }}>
            <p className="text-4xl font-bold text-white mb-2">🌟 MEGA COOKIE! 🌟</p>
            <p className="text-xl text-yellow-100"><span className="text-white font-bold">SMASH NOW!</span> Big downward motion for <span className="text-yellow-300 font-bold">100x</span> Click-Power!</p>
            <p className="text-sm text-yellow-200 mt-2 animate-pulse">💥 Quick! Move hand DOWN hard!</p>
          </div>
        </div>
      )}
      
      {/* === BURNT COOKIE SABOTAGE POPUP === */}
      {burntCookiePopup && gameMode === 'clicker' && (
        <div className="absolute bottom-32 left-1/2 transform -translate-x-1/2 z-50 animate-bounce">
          <div className="bg-gradient-to-r from-red-700 to-orange-600 border-4 border-red-400 rounded-2xl px-8 py-6 text-center"
               style={{ boxShadow: '0 0 40px rgba(220, 38, 38, 0.8)' }}>
            <p className="text-3xl font-bold text-white mb-2">🔥 SABOTAGE!</p>
            <p className="text-xl text-red-200">Make a <span className="text-yellow-300 font-bold">FIST</span> to throw a Burnt Cookie!</p>
            <p className="text-sm text-red-300 mt-2 animate-pulse">👊 Close your hand to sabotage opponent!</p>
          </div>
        </div>
      )}
      
      {/* === BURNT COOKIE OVERLAY (received sabotage) === */}
      {burntCookieActive && gameMode === 'clicker' && (
        <div className="absolute top-20 left-1/2 transform -translate-x-1/2 z-40 pointer-events-none">
          <div className="relative">
            <svg width="180" height="180" viewBox="0 0 180 180">
              <circle cx="90" cy="90" r="80" fill="#2d1b0e" stroke="#4a2c0a" strokeWidth="4" />
              <circle cx="90" cy="90" r="65" fill="#1a0f06" opacity="0.7" />
              {/* Smoke wisps */}
              <path d="M60 40 Q70 20 80 35 Q90 15 95 30" fill="none" stroke="gray" strokeWidth="2" opacity="0.6">
                <animate attributeName="d" values="M60 40 Q70 20 80 35 Q90 15 95 30;M55 35 Q65 10 85 30 Q95 5 100 25;M60 40 Q70 20 80 35 Q90 15 95 30" dur="2s" repeatCount="indefinite" />
              </path>
              <path d="M100 45 Q110 25 115 40" fill="none" stroke="gray" strokeWidth="2" opacity="0.5">
                <animate attributeName="d" values="M100 45 Q110 25 115 40;M95 40 Q108 15 120 35;M100 45 Q110 25 115 40" dur="1.8s" repeatCount="indefinite" />
              </path>
            </svg>
            <p className="text-center text-red-400 font-bold text-sm mt-1 animate-pulse">🔥 Burnt Cookie! Wipe to clear! →</p>
            <p className="text-center text-red-300 text-xs">CPS halved! Swipe hand LEFT/RIGHT</p>
          </div>
        </div>
      )}
      
      {/* === DIVE INDICATOR (Flappy Bird) === */}
      {diveActive && gameMode === 'race' && (
        <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-30 pointer-events-none">
          <div className="bg-red-600 bg-opacity-80 rounded-full px-6 py-2 animate-pulse">
            <p className="text-white font-bold text-lg">⚡ DIVING ⚡</p>
          </div>
        </div>
      )}
    </div>
  );
}
