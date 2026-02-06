import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { format } from 'date-fns';
import { 
  FaVolumeUp, 
  FaWifi, 
  FaBatteryFull,
  FaCogs,
  FaTerminal 
} from 'react-icons/fa';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { systemPreferences } from 'electron';

const execAsync = promisify(exec);

export default function Taskbar() {
  const [time, setTime] = useState(new Date());
  const [network, setNetwork] = useState({});
  const [battery, setBattery] = useState({});
  const [volume, setVolume] = useState(100);
  const [quickSettings, setQuickSettings] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    
    // Monitor network
    const netInterval = setInterval(async () => {
      const stats = await execAsync('netstat -ibn');
      setNetwork(parseNetwork(stats.stdout));
    }, 5000);
    
    return () => {
      clearInterval(timer);
      clearInterval(netInterval);
    };
  }, []);

  // System commands
  const openTerminal = () => {
    execAsync(os.platform() === 'win32' ? 'start cmd' : 'open -a Terminal');
  };

  const openTaskManager = () => {
    // Custom task manager modal
    setQuickSettings(true);
  };

  return (
    <motion.div 
      className="taskbar"
      initial={{ y: 100 }}
      animate={{ y: 0 }}
      transition={{ type: 'spring', stiffness: 200, damping: 25 }}
    >
      <div className="start-menu">
        <button className="start-button">
          <FaCogs /> FireOS
        </button>
      </div>
      
      <div className="taskbar-items">
        <button onClick={openTerminal}>
          <FaTerminal /> Terminal
        </button>
      </div>
      
      <div className="system-tray">
        <div className="tray-item">
          <FaWifi /> {network.speed || '100 Mbps'}
        </div>
        <div className="tray-item">
          <FaVolumeUp /> {volume}%
        </div>
        <div className="tray-item">
          <FaBatteryFull /> {battery.percentage || '100'}%
        </div>
        <div className="tray-item time" onClick={openTaskManager}>
          {format(time, 'HH:mm')}
          <br />
          {format(time, 'dd/MM/yyyy')}
        </div>
      </div>

      {quickSettings && (
        <div className="quick-settings">
          {/* System settings panel */}
        </div>
      )}
    </motion.div>
  );
}
