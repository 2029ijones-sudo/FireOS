import { useState, useEffect, useRef } from 'react';
import { motion, useAnimation, useMotionValue, useTransform } from 'framer-motion';
import { Rnd } from 'react-rnd';
import { ResizableBox } from 'react-resizable';
import { WebSocket } from 'ws';
import { io } from 'socket.io-client';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { FaTimes, FaWindowMinimize, FaWindowMaximize, FaGripLines } from 'react-icons/fa';
import { createWorker } from 'tesseract.js';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

export default function AppWindow({ app, onClose, onMinimize, onMaximize, zIndex }) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [position, setPosition] = useState({ x: 100, y: 100 });
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [content, setContent] = useState(null);
  const [performance, setPerformance] = useState({ fps: 60, memory: 0 });
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  
  const windowRef = useRef();
  const canvasRef = useRef();
  const ffmpegRef = useRef(new FFmpeg());
  const socketRef = useRef(io('wss://fireos-websocket.fireos.app'));
  const mediaRecorderRef = useRef();
  const animationFrameRef = useRef();
  
  const dragX = useMotionValue(position.x);
  const dragY = useMotionValue(position.y);
  const rotate = useTransform([dragX, dragY], [latestX, latestY] => 
    Math.atan2(latestY - position.y, latestX - position.x) * (180 / Math.PI)
  );

  // Load app content based on APK type
  useEffect(() => {
    loadAppContent();
    
    // Performance monitoring
    const monitorInterval = setInterval(() => {
      const fps = calculateFPS();
      const memory = window.performance.memory ? 
        window.performance.memory.usedJSHeapSize / 1048576 : 0;
      setPerformance({ fps, memory });
    }, 1000);

    // WebSocket for real-time updates
    socketRef.current.on('app-update', (data) => {
      if (data.appId === app.id) {
        handleAppUpdate(data);
      }
    });

    return () => {
      clearInterval(monitorInterval);
      socketRef.current.disconnect();
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  const loadAppContent = async () => {
    try {
      // Decode APK content
      const response = await fetch(`/api/apps/${app.id}/content`);
      const apkData = await response.json();
      
      // Parse manifest
      const manifest = parseAPKManifest(apkData.manifest);
      
      // Load appropriate renderer
      switch (manifest.type) {
        case 'webview':
          setContent(<WebView src={apkData.entryPoint} />);
          break;
        case 'canvas':
          setContent(<CanvasApp canvasData={apkData.canvas} />);
          break;
        case 'terminal':
          setContent(<TerminalEmulator commands={apkData.commands} />);
          break;
        default:
          setContent(<iframe src={apkData.entryPoint} title={app.name} />);
      }

      // Initialize hardware acceleration
      if (manifest.hardwareAcceleration) {
        initializeWebGL();
      }
    } catch (error) {
      toast.error(`Failed to load app: ${error.message}`);
    }
  };

  const initializeWebGL = () => {
    const canvas = canvasRef.current;
    const gl = canvas.getContext('webgl2') || canvas.getContext('experimental-webgl');
    
    if (gl) {
      // Setup shaders and buffers
      const vertexShader = gl.createShader(gl.VERTEX_SHADER);
      const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
      
      // Compile shaders
      gl.shaderSource(vertexShader, `
        attribute vec2 position;
        void main() {
          gl_Position = vec4(position, 0.0, 1.0);
        }
      `);
      
      gl.shaderSource(fragmentShader, `
        precision highp float;
        uniform float time;
        void main() {
          gl_FragColor = vec4(
            sin(time * 0.001),
            cos(time * 0.001),
            sin(time * 0.0015),
            1.0
          );
        }
      `);
      
      gl.compileShader(vertexShader);
      gl.compileShader(fragmentShader);
      
      const program = gl.createProgram();
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      gl.useProgram(program);
      
      // Animation loop
      const animate = (time) => {
        gl.uniform1f(gl.getUniformLocation(program, 'time'), time);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        animationFrameRef.current = requestAnimationFrame(animate);
      };
      animate(0);
    }
  };

  const startScreenRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ 
        video: { frameRate: 60 },
        audio: true 
      });
      
      mediaRecorderRef.current = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=vp9',
        videoBitsPerSecond: 8000000
      });
      
      const chunks = [];
      mediaRecorderRef.current.ondataavailable = (e) => chunks.push(e.data);
      mediaRecorderRef.current.onstop = async () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        await saveRecording(blob);
      };
      
      mediaRecorderRef.current.start();
      setIsRecording(true);
      toast.info('Screen recording started');
    } catch (error) {
      toast.error(`Recording failed: ${error.message}`);
    }
  };

  const transcribeAudio = async (audioBlob) => {
    setIsTranscribing(true);
    try {
      const worker = await createWorker('eng');
      const { data: { text } } = await worker.recognize(audioBlob);
      toast.success(`Transcription: ${text}`);
      return text;
    } catch (error) {
      toast.error(`Transcription failed: ${error.message}`);
    } finally {
      setIsTranscribing(false);
    }
  };

  const handleAppUpdate = (data) => {
    switch (data.action) {
      case 'content-update':
        setContent(prev => updateContent(prev, data.payload));
        break;
      case 'state-change':
        updateAppState(data.state);
        break;
      case 'notification':
        showAppNotification(data.message);
        break;
    }
  };

  const calculateFPS = () => {
    let frames = 0;
    const start = performance.now();
    
    const countFrame = () => {
      frames++;
      if (performance.now() - start < 1000) {
        requestAnimationFrame(countFrame);
      }
    };
    countFrame();
    
    return frames;
  };

  return (
    <motion.div
      className={`app-window ${isFullscreen ? 'fullscreen' : ''}`}
      style={{ 
        zIndex,
        position: 'absolute',
        x: dragX,
        y: dragY,
        rotate,
        width: size.width,
        height: size.height
      }}
      drag
      dragMomentum={false}
      dragElastic={0.1}
      onDragEnd={(event, info) => {
        setPosition({ x: info.point.x, y: info.point.y });
      }}
      ref={windowRef}
    >
      <div className="window-header" style={{ cursor: 'move' }}>
        <div className="window-title">
          <FaGripLines style={{ marginRight: 8 }} />
          {app.name}
          <span className="window-performance">
            {performance.fps}FPS | {performance.memory.toFixed(1)}MB
          </span>
        </div>
        
        <div className="window-controls">
          <button onClick={onMinimize}>
            <FaWindowMinimize />
          </button>
          <button onClick={() => {
            setIsFullscreen(!isFullscreen);
            onMaximize();
          }}>
            <FaWindowMaximize />
          </button>
          <button onClick={onClose} className="close-button">
            <FaTimes />
          </button>
        </div>
      </div>
      
      <div className="window-toolbar">
        <button onClick={startScreenRecording} disabled={isRecording}>
          {isRecording ? '⏺ Recording...' : '⏺ Record'}
        </button>
        <button onClick={() => setIsTranscribing(true)} disabled={isTranscribing}>
          {isTranscribing ? '🎤 Transcribing...' : '🎤 Transcribe'}
        </button>
        <button onClick={initializeWebGL}>🔄 WebGL</button>
      </div>
      
      <div className="window-content">
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
        {content}
      </div>
      
      <div className="window-status">
        <div className="status-item">🟢 Connected</div>
        <div className="status-item">📶 {performance.fps} FPS</div>
        <div className="status-item">💾 {performance.memory.toFixed(1)} MB</div>
      </div>
      
      <ToastContainer position="bottom-right" />
    </motion.div>
  );
}

// Helper components
const WebView = ({ src }) => (
  <webview 
    src={src}
    style={{ width: '100%', height: '100%' }}
    partition="persist:fireos"
    preload="./preload.js"
  />
);

const CanvasApp = ({ canvasData }) => {
  const canvasRef = useRef();
  
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    // Render canvas content
    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Draw canvasData
      canvasData.forEach(drawCommand => {
        evalDrawCommand(ctx, drawCommand);
      });
      requestAnimationFrame(render);
    };
    render();
  }, [canvasData]);
  
  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />;
};

const TerminalEmulator = ({ commands }) => {
  const [output, setOutput] = useState([]);
  const [input, setInput] = useState('');
  const terminalRef = useRef();
  
  const executeCommand = async (cmd) => {
    try {
      const response = await fetch('/api/terminal', {
        method: 'POST',
        body: JSON.stringify({ command: cmd })
      });
      const result = await response.text();
      setOutput(prev => [...prev, `$ ${cmd}`, result]);
    } catch (error) {
      setOutput(prev => [...prev, `Error: ${error.message}`]);
    }
  };
  
  return (
    <div className="terminal">
      <div className="terminal-output" ref={terminalRef}>
        {output.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyPress={(e) => {
          if (e.key === 'Enter') {
            executeCommand(input);
            setInput('');
          }
        }}
        placeholder="Enter command..."
      />
    </div>
  );
};
