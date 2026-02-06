import { useEffect, useState, useRef } from 'react';
import { motion, useAnimation } from 'framer-motion';
import { Rnd } from 'react-rnd';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { useVirtual } from 'react-virtual';
import { systeminformation } from 'systeminformation';
import { toast, ToastContainer } from 'react-toastify';
import { ipcRenderer } from 'electron';
import { createGlobalState } from 'react-hooks-global-state';

// OS Kernel Simulation
const { setGlobalState, getGlobalState } = createGlobalState({
  processes: [],
  memory: { used: 0, total: 16 * 1024 * 1024 * 1024 }, // 16GB virtual
  cpu: { usage: 0, cores: 8 },
  filesystem: new Map(),
  network: { up: 0, down: 0 }
});

export default function Desktop() {
  const [windows, setWindows] = useState([]);
  const [processes, setProcesses] = useState([]);
  const desktopRef = useRef();
  const [sysInfo, setSysInfo] = useState({});

  // Real-time system monitoring
  useEffect(() => {
    const interval = setInterval(async () => {
      const cpu = await systeminformation.currentLoad();
      const mem = await systeminformation.mem();
      const temp = await systeminformation.cpuTemperature();
      
      setSysInfo({ cpu, mem, temp });
      
      // Update global OS state
      setGlobalState('cpu', { usage: cpu.currentLoad, cores: cpu.cpus.length });
      setGlobalState('memory', { used: mem.active, total: mem.total });
    }, 1000);
    
    return () => clearInterval(interval);
  }, []);

  // Virtual filesystem operations
  const createFile = (path, content) => {
    const fs = getGlobalState('filesystem');
    fs.set(path, { content, created: Date.now(), modified: Date.now() });
    setGlobalState('filesystem', new Map(fs));
  };

  // Process management (like Task Manager)
  const killProcess = (pid) => {
    setProcesses(prev => prev.filter(p => p.pid !== pid));
  };

  // Window management with physics
  const launchApp = (app) => {
    const newWindow = {
      id: Date.now(),
      app,
      x: Math.random() * 500,
      y: Math.random() * 300,
      width: 800,
      height: 600,
      zIndex: windows.length + 1,
      minimized: false,
      focused: true
    };
    
    setWindows(prev => prev.map(w => ({ ...w, focused: false })).concat(newWindow));
    
    // Add to process list
    setProcesses(prev => [...prev, {
      pid: Date.now(),
      name: app.name,
      cpu: 0,
      memory: Math.floor(Math.random() * 1000000),
      status: 'running'
    }]);
  };

  return (
    <DndProvider backend={HTML5Backend}>
      <div ref={desktopRef} className="desktop">
        {/* System Tray */}
        <div className="system-tray">
          <div className="cpu-meter">
            CPU: {sysInfo.cpu?.currentLoad.toFixed(1)}%
          </div>
          <div className="memory-meter">
            RAM: {(sysInfo.mem?.active / 1024 / 1024 / 1024).toFixed(1)}GB
          </div>
        </div>

        {/* Virtual Windows */}
        {windows.map(win => (
          <Rnd
            key={win.id}
            default={{ x: win.x, y: win.y, width: win.width, height: win.height }}
            minWidth={300}
            minHeight={200}
            bounds="parent"
            enableResizing={{
              top: true, right: true, bottom: true, left: true,
              topRight: true, bottomRight: true, bottomLeft: true, topLeft: true
            }}
            dragHandleClassName="window-header"
            onDragStop={(e, d) => {
              setWindows(prev => prev.map(w => 
                w.id === win.id ? { ...w, x: d.x, y: d.y } : w
              ));
            }}
            onResizeStop={(e, direction, ref, delta, position) => {
              setWindows(prev => prev.map(w => 
                w.id === win.id ? { 
                  ...w, 
                  width: ref.offsetWidth, 
                  height: ref.offsetHeight,
                  ...position 
                } : w
              ));
            }}
          >
            <motion.div 
              className={`window ${win.focused ? 'focused' : ''}`}
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              onClick={() => setWindows(prev => prev.map(w => ({
                ...w, 
                focused: w.id === win.id,
                zIndex: w.id === win.id ? 999 : w.zIndex
              })))}
            >
              <div className="window-header">
                <span>{win.app.name}</span>
                <div className="window-controls">
                  <button onClick={() => setWindows(prev => prev.map(w => 
                    w.id === win.id ? { ...w, minimized: true } : w
                  ))}>_</button>
                  <button onClick={() => setWindows(prev => prev.filter(w => w.id !== win.id))}>✕</button>
                </div>
              </div>
              <div className="window-content">
                {/* App content goes here */}
              </div>
            </motion.div>
          </Rnd>
        ))}
        
        <ToastContainer position="bottom-right" autoClose={3000} />
      </div>
    </DndProvider>
  );
}
