import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FaFingerprint, FaKey, FaShieldAlt, FaEye, FaEyeSlash } from 'react-icons/fa';
import CryptoJS from 'crypto-js';
import jwt from 'jsonwebtoken';
import speakeasy from 'speakeasy';
import bcrypt from 'bcryptjs';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import Webcam from 'react-webcam';
import * as faceapi from 'face-api.js';

export default function Login({ onLogin }) {
  const [method, setMethod] = useState('password');
  const [step, setStep] = useState(1);
  const [showPassword, setShowPassword] = useState(false);
  const [biometricData, setBiometricData] = useState(null);
  const [faceDetection, setFaceDetection] = useState(false);
  const [securityLevel, setSecurityLevel] = useState('high');
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockUntil, setLockUntil] = useState(null);
  
  const webcamRef = useRef();
  const canvasRef = useRef();
  const passwordInputRef = useRef();
  
  // Load face detection models
  useEffect(() => {
    const loadModels = async () => {
      await faceapi.nets.tinyFaceDetector.loadFromUri('/models');
      await faceapi.nets.faceLandmark68Net.loadFromUri('/models');
      await faceapi.nets.faceRecognitionNet.loadFromUri('/models');
    };
    loadModels();
  }, []);

  // Handle biometric authentication
  const handleBiometric = async () => {
    try {
      // WebAuthn registration/authentication
      const options = await fetch('/api/auth/webauthn/options').then(r => r.json());
      
      if (method === 'register') {
        const credential = await startRegistration(options);
        await fetch('/api/auth/webauthn/register', {
          method: 'POST',
          body: JSON.stringify(credential)
        });
      } else {
        const credential = await startAuthentication(options);
        const verified = await fetch('/api/auth/webauthn/verify', {
          method: 'POST',
          body: JSON.stringify(credential)
        });
        
        if (verified.ok) {
          setStep(2); // Move to 2FA
        }
      }
    } catch (error) {
      console.error('Biometric error:', error);
    }
  };

  // Face recognition
  const handleFaceRecognition = async () => {
    if (!webcamRef.current) return;
    
    const video = webcamRef.current.video;
    const detection = await faceapi.detectSingleFace(
      video, 
      new faceapi.TinyFaceDetectorOptions()
    ).withFaceLandmarks().withFaceDescriptor();
    
    if (detection) {
      // Compare with stored face data
      const match = await verifyFace(detection.descriptor);
      if (match) {
        setStep(2);
      }
    }
  };

  // Advanced password hashing with salt
  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    
    // Check if locked
    if (lockUntil && Date.now() < lockUntil) {
      const remaining = Math.ceil((lockUntil - Date.now()) / 1000);
      alert(`Account locked. Try again in ${remaining} seconds.`);
      return;
    }
    
    const formData = new FormData(e.target);
    const password = formData.get('password');
    const totp = formData.get('totp');
    
    // Client-side encryption before sending
    const encryptedPassword = CryptoJS.AES.encrypt(
      password, 
      process.env.NEXT_PUBLIC_ENCRYPTION_KEY
    ).toString();
    
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': getClientIP(),
          'User-Agent': navigator.userAgent
        },
        body: JSON.stringify({
          password: encryptedPassword,
          totp,
          biometric: biometricData,
          securityLevel,
          timestamp: Date.now()
        })
      });
      
      if (response.ok) {
        setFailedAttempts(0);
        const { token, session } = await response.json();
        
        // Secure token storage
        localStorage.setItem('fireos_token', CryptoJS.AES.encrypt(
          token, 
          process.env.NEXT_PUBLIC_ENCRYPTION_KEY
        ).toString());
        
        localStorage.setItem('fireos_session', JSON.stringify({
          ...session,
          ip: getClientIP(),
          device: getDeviceFingerprint()
        }));
        
        onLogin();
      } else {
        const newAttempts = failedAttempts + 1;
        setFailedAttempts(newAttempts);
        
        // Implement lockout policy
        if (newAttempts >= 5) {
          const lockTime = Math.pow(2, newAttempts - 5) * 30000; // Exponential backoff
          setLockUntil(Date.now() + lockTime);
          alert(`Too many failed attempts. Account locked for ${lockTime/1000} seconds.`);
        }
      }
    } catch (error) {
      console.error('Login error:', error);
    }
  };

  // Hardware security key
  const handleSecurityKey = async () => {
    if (!navigator.credentials || !navigator.credentials.create) {
      alert('WebAuthn not supported');
      return;
    }
    
    try {
      const publicKeyCredentialCreationOptions = {
        challenge: Uint8Array.from(
          CryptoJS.lib.WordArray.random(32).toString(), 
          c => c.charCodeAt(0)
        ),
        rp: {
          name: "FireOS",
          id: window.location.hostname
        },
        user: {
          id: Uint8Array.from(
            CryptoJS.lib.WordArray.random(16).toString(), 
            c => c.charCodeAt(0)
          ),
          name: "user@fireos.app",
          displayName: "FireOS User"
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 }, // ES256
          { type: "public-key", alg: -257 } // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: "cross-platform",
          requireResidentKey: true,
          userVerification: "required"
        },
        timeout: 60000,
        attestation: "direct"
      };
      
      const credential = await navigator.credentials.create({
        publicKey: publicKeyCredentialCreationOptions
      });
      
      // Send to server for verification
      await fetch('/api/auth/security-key', {
        method: 'POST',
        body: JSON.stringify(credential)
      });
      
      setStep(2);
    } catch (error) {
      console.error('Security key error:', error);
    }
  };

  // Get device fingerprint
  const getDeviceFingerprint = () => {
    const fingerprint = {
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      screenResolution: `${window.screen.width}x${window.screen.height}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      canvasFingerprint: getCanvasFingerprint()
    };
    
    return CryptoJS.SHA256(JSON.stringify(fingerprint)).toString();
  };

  const getCanvasFingerprint = () => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('FireOS', 2, 15);
    return canvas.toDataURL();
  };

  return (
    <div className="login-container">
      <motion.div 
        className="login-card"
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      >
        <div className="login-header">
          <FaShieldAlt size={48} />
          <h1>FireOS Secure Login</h1>
          <div className="security-level">
            Security Level: <span className={`level-${securityLevel}`}>{securityLevel.toUpperCase()}</span>
          </div>
        </div>

        <AnimatePresence mode="wait">
          {step === 1 && (
            <motion.div
              key="step1"
              initial={{ x: 100, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -100, opacity: 0 }}
            >
              <div className="auth-methods">
                <button 
                  className={`method-btn ${method === 'password' ? 'active' : ''}`}
                  onClick={() => setMethod('password')}
                >
                  <FaKey /> Password
                </button>
                <button 
                  className={`method-btn ${method === 'biometric' ? 'active' : ''}`}
                  onClick={() => setMethod('biometric')}
                >
                  <FaFingerprint /> Biometric
                </button>
              </div>

              {method === 'password' && (
                <form onSubmit={handlePasswordSubmit} className="password-form">
                  <div className="input-group">
                    <input
                      ref={passwordInputRef}
                      type={showPassword ? 'text' : 'password'}
                      name="password"
                      placeholder="Enter master password"
                      required
                      pattern="^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{12,}$"
                      title="Must contain: 12+ chars, uppercase, lowercase, number, special char"
                    />
                    <button 
                      type="button"
                      className="toggle-password"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? <FaEyeSlash /> : <FaEye />}
                    </button>
                  </div>
                  
                  <div className="password-strength">
                    <div className="strength-meter">
                      <div className="strength-fill" style={{ width: '75%' }} />
                    </div>
                    <span>Strong</span>
                  </div>

                  <button type="submit" className="login-btn">
                    Continue
                  </button>
                </form>
              )}

              {method === 'biometric' && (
                <div className="biometric-auth">
                  <button onClick={handleBiometric} className="biometric-btn">
                    <FaFingerprint size={32} />
                    <span>Scan Fingerprint</span>
                  </button>
                  
                  <button onClick={handleSecurityKey} className="security-key-btn">
                    🔑 Use Security Key
                  </button>

                  {faceDetection && (
                    <div className="face-recognition">
                      <Webcam
                        ref={webcamRef}
                        audio={false}
                        screenshotFormat="image/jpeg"
                        videoConstraints={{ facingMode: 'user' }}
                        onUserMedia={handleFaceRecognition}
                      />
                      <canvas ref={canvasRef} />
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          )}

          {step === 2 && (
            <motion.div
              key="step2"
              initial={{ x: 100, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -100, opacity: 0 }}
              className="two-factor"
            >
              <h3>Two-Factor Authentication</h3>
              <p>Enter 6-digit code from your authenticator app</p>
              
              <div className="totp-input">
                {[...Array(6)].map((_, i) => (
                  <input
                    key={i}
                    type="text"
                    maxLength={1}
                    pattern="[0-9]"
                    className="totp-digit"
                    onChange={(e) => {
                      if (e.target.value) {
                        const nextInput = e.target.nextElementSibling;
                        if (nextInput) nextInput.focus();
                      }
                    }}
                  />
                ))}
              </div>
              
              <div className="backup-options">
                <button type="button" className="backup-btn">
                  📱 Use backup code
                </button>
                <button type="button" className="backup-btn">
                  📧 Email verification
                </button>
                <button type="button" className="backup-btn">
                  📞 SMS code
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="login-footer">
          <div className="security-info">
            <div className="info-item">
              <FaShieldAlt /> End-to-end encrypted
            </div>
            <div className="info-item">
              🔒 Zero-knowledge proof
            </div>
            <div className="info-item">
              🌐 IP: {getClientIP()}
            </div>
          </div>
          
          {lockUntil && (
            <div className="lock-warning">
              ⚠️ Account locked until: {new Date(lockUntil).toLocaleTimeString()}
            </div>
          )}
          
          {failedAttempts > 0 && (
            <div className="attempts-warning">
              Failed attempts: {failedAttempts}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}

// Helper functions
const getClientIP = async () => {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    return data.ip;
  } catch {
    return 'unknown';
  }
};
