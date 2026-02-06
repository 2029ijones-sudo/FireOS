import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import multer from 'multer';
import multerS3 from 'multer-s3';
import archiver from 'archiver';
import crypto from 'crypto';
import JSZip from 'jszip';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

// Configure multer for S3 upload
const upload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: process.env.S3_BUCKET,
    acl: 'private',
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: function (req, file, cb) {
      const hash = crypto.createHash('sha256');
      hash.update(file.originalname + Date.now());
      cb(null, `apks/${hash.digest('hex')}.${file.originalname.split('.').pop()}`);
    }
  }),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB
    files: 5
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/zip', 'application/vnd.android.package-archive'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only APK and ZIP allowed.'));
    }
  }
});

export async function POST(request) {
  try {
    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get('apk');
    const manifest = JSON.parse(formData.get('manifest'));
    
    if (!file || !manifest) {
      return NextResponse.json(
        { error: 'File and manifest required' },
        { status: 400 }
      );
    }
    
    // Generate file hash
    const buffer = await file.arrayBuffer();
    const hash = crypto.createHash('sha256');
    hash.update(Buffer.from(buffer));
    const fileHash = hash.digest('hex');
    
    // Check if app already exists
    const { data: existingApp } = await supabase
      .from('apps')
      .select('id')
      .eq('hash', fileHash)
      .single();
    
    if (existingApp) {
      return NextResponse.json(
        { error: 'App already exists' },
        { status: 409 }
      );
    }
    
    // Upload to S3
    const s3Key = `apks/${fileHash}.${file.name.split('.').pop()}`;
    
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: s3Key,
      Body: Buffer.from(buffer),
      ContentType: file.type,
      Metadata: {
        'hash': fileHash,
        'name': manifest.name,
        'version': manifest.version
      }
    }));
    
    // Extract and validate APK contents
    const zip = new JSZip();
    const zipContents = await zip.loadAsync(buffer);
    
    // Check for malicious files
    const maliciousPatterns = [
      /\.(exe|bat|sh|php|py|js)$/i,
      /__MACOSX/,
      /\.DS_Store/
    ];
    
    let maliciousFiles = [];
    Object.keys(zipContents.files).forEach(filename => {
      if (maliciousPatterns.some(pattern => pattern.test(filename))) {
        maliciousFiles.push(filename);
      }
    });
    
    if (maliciousFiles.length > 0) {
      // Delete uploaded file
      await s3Client.send(new DeleteObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: s3Key
      }));
      
      return NextResponse.json(
        { 
          error: 'Malicious files detected',
          files: maliciousFiles 
        },
        { status: 400 }
      );
    }
    
    // Generate preview images
    let iconUrl = null;
    let screenshotUrls = [];
    
    // Extract icon
    const iconFile = zipContents.file('icon.png') || 
                     zipContents.file('assets/icon.png') ||
                     zipContents.file('res/drawable/icon.png');
    
    if (iconFile) {
      const iconBuffer = await iconFile.async('nodebuffer');
      const iconKey = `icons/${fileHash}.png`;
      
      await s3Client.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: iconKey,
        Body: iconBuffer,
        ContentType: 'image/png'
      }));
      
      iconUrl = `https://${process.env.S3_BUCKET}.s3.amazonaws.com/${iconKey}`;
    }
    
    // Extract screenshots
    const screenshotFiles = Object.keys(zipContents.files)
      .filter(name => name.includes('screenshot') && /\.(png|jpg|jpeg)$/i.test(name));
    
    for (let i = 0; i < Math.min(screenshotFiles.length, 5); i++) {
      const screenshotFile = zipContents.file(screenshotFiles[i]);
      if (screenshotFile) {
        const screenshotBuffer = await screenshotFile.async('nodebuffer');
        const screenshotKey = `screenshots/${fileHash}_${i}.png`;
        
        await s3Client.send(new PutObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: screenshotKey,
          Body: screenshotBuffer,
          ContentType: 'image/png'
        }));
        
        screenshotUrls.push(
          `https://${process.env.S3_BUCKET}.s3.amazonaws.com/${screenshotKey}`
        );
      }
    }
    
    // Store app metadata in Supabase
    const { data: app, error: appError } = await supabase
      .from('apps')
      .insert({
        name: manifest.name,
        version: manifest.version,
        type: manifest.type,
        entry_point: manifest.entryPoint,
        permissions: manifest.permissions || [],
        description: manifest.description,
        author: manifest.author,
        license: manifest.license,
        icon_url: iconUrl,
        screenshot_urls: screenshotUrls,
        download_url: `https://${process.env.S3_BUCKET}.s3.amazonaws.com/${s3Key}`,
        hash: fileHash,
        size: buffer.byteLength,
        verified: false, // Needs virus scan
        upload_date: new Date().toISOString(),
        downloads: 0,
        rating: 0
      })
      .select()
      .single();
    
    if (appError) {
      throw appError;
    }
    
    // Trigger virus scan
    await fetch('https://scan.fireos.workers.dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: app.id,
        fileHash,
        url: app.download_url
      })
    });
    
    return NextResponse.json({
      success: true,
      app: {
        id: app.id,
        name: app.name,
        version: app.version,
        icon: app.icon_url,
        description: app.description,
        status: 'uploaded'
      }
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: error.message || 'Upload failed' },
      { status: 500 }
    );
  }
}
