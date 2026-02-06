import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Dropzone from 'react-dropzone';
import { Tree, Node } from 'react-arborist';
import { FaSearch, FaFolder, FaFile, FaDownload, FaUpload, FaTrash, FaShare, FaCode } from 'react-icons/fa';
import { Tab, Tabs, TabList, TabPanel } from 'react-tabs';
import 'react-tabs/style/react-tabs.css';
import JSZip from 'jszip';
import { ffprobe } from 'fluent-ffmpeg';
import { PDFDocument } from 'pdf-lib';
import { toast, ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { io } from 'socket.io-client';

export default function AppStore() {
  const [view, setView] = useState('store'); // 'store', 'explorer', 'editor'
  const [apps, setApps] = useState([]);
  const [files, setFiles] = useState([]);
  const [search, setSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const [currentFile, setCurrentFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [socket, setSocket] = useState(null);
  
  const fileInputRef = useRef();
  const editorRef = useRef();
  const zipRef = useRef(new JSZip());

  // WebSocket for real-time updates
  useEffect(() => {
    const socket = io('wss://fireos-appstore.fireos.app');
    setSocket(socket);
    
    socket.on('app-added', (app) => {
      setApps(prev => [...prev, app]);
      toast.success(`New app: ${app.name}`);
    });
    
    socket.on('file-update', (update) => {
      updateFileSystem(update);
    });
    
    return () => socket.disconnect();
  }, []);

  // Handle APK upload
  const handleDrop = async (acceptedFiles) => {
    setUploading(true);
    
    for (const file of acceptedFiles) {
      try {
        // Validate APK
        if (!file.name.endsWith('.apk') && !file.name.endsWith('.zip')) {
          toast.error(`${file.name}: Must be APK or ZIP`);
          continue;
        }
        
        // Read and validate file
        const buffer = await file.arrayBuffer();
        
        // Check file size
        if (buffer.byteLength > 100 * 1024 * 1024) { // 100MB limit
          toast.error(`${file.name}: File too large`);
          continue;
        }
        
        // Extract and validate manifest
        const zip = await JSZip.loadAsync(buffer);
        const manifestFile = zip.file('manifest.json') || zip.file('app/manifest.json');
        
        if (!manifestFile) {
          toast.error(`${file.name}: No manifest found`);
          continue;
        }
        
        const manifest = JSON.parse(await manifestFile.async('text'));
        
        // Validate required fields
        const required = ['name', 'version', 'type', 'entryPoint'];
        const missing = required.filter(field => !manifest[field]);
        
        if (missing.length > 0) {
          toast.error(`${file.name}: Missing fields: ${missing.join(', ')}`);
          continue;
        }
        
        // Scan for viruses
        const scanResult = await scanFile(buffer, file.name);
        
        if (!scanResult.clean) {
          toast.error(`${file.name}: Failed virus scan`);
          continue;
        }
        
        // Upload to Cloudflare
        const formData = new FormData();
        formData.append('apk', file);
        formData.append('manifest', JSON.stringify(manifest));
        
        const response = await fetch('/api/upload', {
          method: 'POST',
          body: formData
        });
        
        if (response.ok) {
          const appData = await response.json();
          setApps(prev => [...prev, appData]);
          toast.success(`${manifest.name} uploaded successfully!`);
          
          // Notify via WebSocket
          socket.emit('app-uploaded', appData);
        }
      } catch (error) {
        toast.error(`Error uploading ${file.name}: ${error.message}`);
      }
    }
    
    setUploading(false);
  };

  // File system operations
  const createFile = (path, type = 'file') => {
    const newFile = {
      id: Date.now().toString(),
      name: type === 'folder' ? 'New Folder' : 'New File.txt',
      path,
      type,
      size: 0,
      created: new Date(),
      modified: new Date(),
      content: type === 'file' ? '' : null
    };
    
    setFiles(prev => [...prev, newFile]);
    return newFile;
  };

  const deleteFile = (id) => {
    setFiles(prev => prev.filter(file => file.id !== id));
    toast.info('File deleted');
  };

  const shareFile = async (file) => {
    try {
      // Generate share link with expiration
      const shareToken = btoa(JSON.stringify({
        fileId: file.id,
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
        salt: crypto.getRandomValues(new Uint8Array(16))
      }));
      
      const shareUrl = `${window.location.origin}/share/${shareToken}`;
      
      // Copy to clipboard
      await navigator.clipboard.writeText(shareUrl);
      toast.success('Share link copied to clipboard');
    } catch (error) {
      toast.error('Failed to generate share link');
    }
  };

  // File preview system
  const previewFile = async (file) => {
    setCurrentFile(file);
    
    if (file.type === 'text') {
      const response = await fetch(file.url);
      const text = await response.text();
      setFileContent(text);
    } else if (file.type === 'image') {
      setFileContent(`<img src="${file.url}" alt="${file.name}" />`);
    } else if (file.type === 'pdf') {
      // Load PDF document
      const pdfBytes = await fetch(file.url).then(r => r.arrayBuffer());
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const pages = pdfDoc.getPages();
      // Convert to images or text for preview
    } else if (file.type === 'video' || file.type === 'audio') {
      // Get media metadata
      ffprobe(file.url, (err, metadata) => {
        if (!err) {
          setFileContent(JSON.stringify(metadata.format, null, 2));
        }
      });
    }
  };

  // APK Builder
  const buildAPK = async () => {
    const zip = new JSZip();
    
    // Add manifest
    const manifest = {
      name: 'Custom App',
      version: '1.0.0',
      type: 'webview',
      entryPoint: 'index.html',
      permissions: ['filesystem', 'network'],
      icon: 'icon.png'
    };
    
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    
    // Add HTML entry point
    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>${manifest.name}</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body>
    <div id="app">Hello from FireOS App!</div>
    <script src="app.js"></script>
</body>
</html>
    `;
    
    zip.file('index.html', html);
    
    // Add JavaScript
    const js = `
class FireOSApp {
    constructor() {
        this.name = "${manifest.name}";
        this.version = "${manifest.version}";
    }
    
    run() {
        document.getElementById('app').innerHTML = 
            '<h1>Running on FireOS!</h1>';
    }
}

new FireOSApp().run();
    `;
    
    zip.file('app.js', js);
    
    // Generate APK
    const apkBlob = await zip.generateAsync({ type: 'blob' });
    
    // Download
    const link = document.createElement('a');
    link.href = URL.createObjectURL(apkBlob);
    link.download = `${manifest.name.toLowerCase().replace(/\s+/g, '-')}.apk`;
    link.click();
    
    toast.success('APK built successfully!');
  };

  // File Editor
  const saveFile = () => {
    if (currentFile && editorRef.current) {
      const content = editorRef.current.value;
      
      setFiles(prev => prev.map(file => 
        file.id === currentFile.id 
          ? { ...file, content, modified: new Date() }
          : file
      ));
      
      toast.info('File saved');
    }
  };

  return (
    <div className="app-store">
      <div className="store-header">
        <div className="search-bar">
          <FaSearch />
          <input
            type="text"
            placeholder="Search apps or files..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        
        <div className="header-actions">
          <button onClick={buildAPK} className="action-btn">
            <FaCode /> Build APK
          </button>
          <button onClick={() => fileInputRef.current?.click()} className="action-btn">
            <FaUpload /> Upload
          </button>
        </div>
      </div>

      <Tabs>
        <TabList>
          <Tab>App Store</Tab>
          <Tab>File Explorer</Tab>
          <Tab>APK Editor</Tab>
          <Tab>Installed Apps</Tab>
        </TabList>

        <TabPanel>
          <Dropzone onDrop={handleDrop} disabled={uploading}>
            {({ getRootProps, getInputProps }) => (
              <div {...getRootProps()} className="drop-zone">
                <input {...getInputProps()} />
                {uploading ? (
                  <div className="uploading">Uploading...</div>
                ) : (
                  <div className="drop-content">
                    <FaUpload size={48} />
                    <p>Drag & drop APK files here</p>
                    <p className="hint">or click to select</p>
                    <p className="requirements">
                      Requirements: .apk or .zip with manifest.json
                    </p>
                  </div>
                )}
              </div>
            )}
          </Dropzone>

          <div className="apps-grid">
            {apps.filter(app => 
              app.name.toLowerCase().includes(search.toLowerCase()) ||
              app.description?.toLowerCase().includes(search.toLowerCase())
            ).map(app => (
              <motion.div
                key={app.id}
                className="app-card"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
              >
                <img src={app.icon} alt={app.name} className="app-icon" />
                <div className="app-info">
                  <h3>{app.name}</h3>
                  <p className="app-version">v{app.version}</p>
                  <p className="app-desc">{app.description}</p>
                  <div className="app-tags">
                    {app.tags?.map(tag => (
                      <span key={tag} className="tag">{tag}</span>
                    ))}
                  </div>
                </div>
                <div className="app-actions">
                  <button className="install-btn">
                    <FaDownload /> Install
                  </button>
                  <button className="info-btn">Details</button>
                </div>
              </motion.div>
            ))}
          </div>
        </TabPanel>

        <TabPanel>
          <div className="file-explorer">
            <div className="explorer-toolbar">
              <button onClick={() => createFile('/', 'folder')}>
                <FaFolder /> New Folder
              </button>
              <button onClick={() => createFile('/', 'file')}>
                <FaFile /> New File
              </button>
              <button onClick={() => fileInputRef.current?.click()}>
                <FaUpload /> Upload
              </button>
            </div>

            <div className="explorer-content">
              <Tree
                data={files}
                width={600}
                height={400}
                indent={24}
                rowHeight={36}
                onRename={({ id, name }) => {
                  setFiles(prev => prev.map(file => 
                    file.id === id ? { ...file, name } : file
                  ));
                }}
                onDelete={({ id }) => deleteFile(id)}
                onSelect={node => previewFile(node.data)}
              >
                {Node}
              </Tree>
            </div>

            {currentFile && (
              <div className="file-preview">
                <div className="preview-header">
                  <h4>{currentFile.name}</h4>
                  <div className="preview-actions">
                    <button onClick={() => shareFile(currentFile)}>
                      <FaShare /> Share
                    </button>
                    <button onClick={() => deleteFile(currentFile.id)}>
                      <FaTrash /> Delete
                    </button>
                  </div>
                </div>
                <div className="preview-content">
                  {fileContent && (
                    <textarea
                      ref={editorRef}
                      value={fileContent}
                      onChange={(e) => setFileContent(e.target.value)}
                      className="file-editor"
                    />
                  )}
                </div>
                <button onClick={saveFile} className="save-btn">
                  Save Changes
                </button>
              </div>
            )}
          </div>
        </TabPanel>

        <TabPanel>
          <div className="apk-editor">
            <div className="editor-header">
              <h3>APK Manifest Editor</h3>
              <button onClick={buildAPK} className="build-btn">
                Build APK
              </button>
            </div>
            
            <div className="editor-content">
              <textarea
                className="manifest-editor"
                defaultValue={JSON.stringify({
                  name: "My App",
                  version: "1.0.0",
                  type: "webview",
                  entryPoint: "index.html",
                  permissions: [],
                  icon: "icon.png",
                  description: "A FireOS application",
                  author: "You",
                  license: "MIT"
                }, null, 2)}
              />
            </div>
          </div>
        </TabPanel>
      </Tabs>

      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        onChange={(e) => handleDrop(Array.from(e.target.files))}
        multiple
        accept=".apk,.zip"
      />

      <ToastContainer position="bottom-right" />
    </div>
  );
}

// Helper functions
const scanFile = async (buffer, filename) => {
  // Send to Cloudflare Worker for scanning
  const response = await fetch('/api/scan', {
    method: 'POST',
    body: JSON.stringify({
      filename,
      size: buffer.byteLength,
      hash: await calculateHash(buffer)
    })
  });
  
  return response.json();
};

const calculateHash = async (buffer) => {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
};
