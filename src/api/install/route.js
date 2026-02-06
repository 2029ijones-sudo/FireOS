import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import JSZip from 'jszip';
import decompress from 'decompress';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);
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

export async function POST(request) {
  try {
    const { appId, userId } = await request.json();
    
    if (!appId || !userId) {
      return NextResponse.json(
        { error: 'Missing parameters' },
        { status: 400 }
      );
    }
    
    // Get app details
    const { data: app, error: appError } = await supabase
      .from('apps')
      .select('*')
      .eq('id', appId)
      .single();
    
    if (appError || !app) {
      return NextResponse.json(
        { error: 'App not found' },
        { status: 404 }
      );
    }
    
    // Check if app is verified
    if (!app.verified) {
      return NextResponse.json(
        { error: 'App not verified. Please wait for scanning to complete.' },
        { status: 403 }
      );
    }
    
    // Download app from S3
    const s3Key = app.download_url.split('.s3.amazonaws.com/')[1];
    
    const { Body: fileStream } = await s3Client.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: s3Key
    }));
    
    // Convert stream to buffer
    const chunks = [];
    for await (const chunk of fileStream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    
    // Create installation directory
    const installDir = `/tmp/fireos/apps/${appId}_${Date.now()}`;
    await fs.mkdir(installDir, { recursive: true });
    
    // Extract APK/ZIP
    let extractedFiles;
    
    if (app.download_url.endsWith('.apk')) {
      // For APK files, use apktool to decompile
      const apkPath = path.join(installDir, 'app.apk');
      await fs.writeFile(apkPath, buffer);
      
      // Decompile APK
      await execAsync(`apktool d ${apkPath} -o ${installDir}/decompiled`);
      
      extractedFiles = await fs.readdir(path.join(installDir, 'decompiled'));
    } else {
      // For ZIP files, extract normally
      extractedFiles = await decompress(buffer, installDir);
    }
    
    // Parse manifest
    const manifestPath = path.join(installDir, 
      app.download_url.endsWith('.apk') ? 'decompiled/AndroidManifest.xml' : 'manifest.json'
    );
    
    let manifest;
    try {
      const manifestContent = await fs.readFile(manifestPath, 'utf8');
      manifest = JSON.parse(manifestContent);
    } catch {
      // Try to parse AndroidManifest.xml
      manifest = await parseAndroidManifest(manifestPath);
    }
    
    // Create app entry in user's installed apps
    const { data: installation, error: installError } = await supabase
      .from('installations')
      .insert({
        user_id: userId,
        app_id: appId,
        installed_at: new Date().toISOString(),
        installation_path: installDir,
        version: app.version,
        status: 'installed',
        permissions: manifest.permissions || [],
        data_path: `/userdata/${userId}/apps/${appId}`
      })
      .select()
      .single();
    
    if (installError) {
      throw installError;
    }
    
    // Create app data directory
    const dataDir = `/userdata/${userId}/apps/${appId}`;
    await fs.mkdir(dataDir, { recursive: true });
    
    // Copy necessary files to data directory
    await fs.cp(
      installDir,
      dataDir,
      { recursive: true }
    );
    
    // Generate runtime configuration
    const runtimeConfig = {
      appId,
      version: app.version,
      permissions: manifest.permissions || [],
      entryPoint: manifest.entryPoint || 'index.html',
      type: manifest.type || 'webview',
      sandboxed: true,
      dataPath: dataDir,
      cachePath: `/cache/${userId}/apps/${appId}`,
      createdAt: new Date().toISOString()
    };
    
    await fs.writeFile(
      path.join(dataDir, 'runtime.json'),
      JSON.stringify(runtimeConfig, null, 2)
    );
    
    // Update app download count
    await supabase
      .from('apps')
      .update({ downloads: (app.downloads || 0) + 1 })
      .eq('id', appId);
    
    // Create desktop shortcut
    const shortcut = {
      name: app.name,
      icon: app.icon_url,
      exec: `fireos://app/${appId}`,
      type: 'application',
      categories: manifest.categories || ['Utility']
    };
    
    await supabase
      .from('shortcuts')
      .insert({
        user_id: userId,
        app_id: appId,
        shortcut_config: shortcut,
        created_at: new Date().toISOString()
      });
    
    return NextResponse.json({
      success: true,
      installation: {
        id: installation.id,
        appId,
        appName: app.name,
        version: app.version,
        installedAt: installation.installed_at,
        dataPath: dataDir,
        runtimeConfig
      },
      shortcut
    });
    
  } catch (error) {
    console.error('Install error:', error);
    return NextResponse.json(
      { error: 'Installation failed: ' + error.message },
      { status: 500 }
    );
  }
}

async function parseAndroidManifest(filePath) {
  try {
    // Simple XML parsing for AndroidManifest.xml
    const content = await fs.readFile(filePath, 'utf8');
    
    const manifest = {
      package: extractXmlValue(content, 'package'),
      versionCode: extractXmlValue(content, 'android:versionCode'),
      versionName: extractXmlValue(content, 'android:versionName'),
      permissions: []
    };
    
    // Extract permissions
    const permissionMatches = content.match(/<uses-permission[^>]+>/g) || [];
    manifest.permissions = permissionMatches.map(tag => {
      const nameMatch = tag.match(/android:name="([^"]+)"/);
      return nameMatch ? nameMatch[1] : null;
    }).filter(Boolean);
    
    // Extract activities
    const activityMatches = content.match(/<activity[^>]+>/g) || [];
    manifest.activities = activityMatches.map(tag => {
      const nameMatch = tag.match(/android:name="([^"]+)"/);
      return nameMatch ? nameMatch[1] : null;
    }).filter(Boolean);
    
    return manifest;
  } catch (error) {
    return {
      permissions: [],
      activities: []
    };
  }
}

function extractXmlValue(xml, attribute) {
  const match = xml.match(new RegExp(`${attribute}="([^"]+)"`));
  return match ? match[1] : null;
}
