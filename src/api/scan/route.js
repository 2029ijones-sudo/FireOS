import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ClamScan } from 'clamdjs';
import fetch from 'node-fetch';
import crypto from 'crypto';
import yara from 'yara';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Initialize ClamAV scanner
const scanner = new ClamScan({
  host: process.env.CLAMAV_HOST || '127.0.0.1',
  port: process.env.CLAMAV_PORT || 3310,
  timeout: 30000
});

// YARA rules for custom detection
const yaraRules = `
rule Suspicious_APK {
    meta:
        description = "Detects suspicious APK patterns"
        author = "FireOS Security"
    strings:
        $magic = { 50 4B 03 04 } // ZIP magic bytes
        $manifest = "AndroidManifest.xml"
        $dex = "classes.dex"
        $suspicious_string = "Runtime.exec" nocase
        $root_string = "su" nocase
        $crypto_mining = "cryptonight" nocase
        $spyware = "getSimSerialNumber" nocase
    condition:
        $magic at 0 and 
        ($manifest or $dex) and
        ($suspicious_string or $root_string or $crypto_mining or $spyware)
}
`;

export async function POST(request) {
  try {
    const { appId, fileHash, url } = await request.json();
    
    if (!appId || !fileHash || !url) {
      return NextResponse.json(
        { error: 'Missing parameters' },
        { status: 400 }
      );
    }
    
    // Download file for scanning
    const response = await fetch(url);
    const buffer = await response.buffer();
    
    // Multi-engine scanning
    const scanResults = await Promise.allSettled([
      scanWithClamAV(buffer),
      scanWithVirusTotal(fileHash),
      scanWithYARA(buffer),
      heuristicAnalysis(buffer)
    ]);
    
    // Compile results
    const results = {
      clamav: scanResults[0].status === 'fulfilled' ? scanResults[0].value : null,
      virustotal: scanResults[1].status === 'fulfilled' ? scanResults[1].value : null,
      yara: scanResults[2].status === 'fulfilled' ? scanResults[2].value : null,
      heuristic: scanResults[3].status === 'fulfilled' ? scanResults[3].value : null,
      overall: 'clean'
    };
    
    // Determine overall status
    const threats = [];
    
    if (results.clamav && results.clamav.is_infected) {
      threats.push(`ClamAV: ${results.clamav.viruses.join(', ')}`);
    }
    
    if (results.virustotal && results.virustotal.positives > 0) {
      threats.push(`VirusTotal: ${results.virustotal.positives}/${results.virustotal.total} engines detected threats`);
    }
    
    if (results.yara && results.yara.matches.length > 0) {
      threats.push(`YARA: ${results.yara.matches.map(m => m.rule).join(', ')}`);
    }
    
    if (results.heuristic && results.heuristic.suspicious) {
      threats.push(`Heuristic: ${results.heuristic.reasons.join(', ')}`);
    }
    
    // Update app status in database
    const status = threats.length > 0 ? 'malicious' : 'clean';
    
    await supabase
      .from('apps')
      .update({
        verified: status === 'clean',
        last_scan: new Date().toISOString(),
        scan_results: results,
        threats: threats.length > 0 ? threats : null,
        status: status
      })
      .eq('id', appId);
    
    if (status === 'malicious') {
      // Log threat
      await supabase
        .from('threat_logs')
        .insert({
          app_id: appId,
          file_hash: fileHash,
          threats,
          scan_results: results,
          detected_at: new Date().toISOString()
        });
      
      // Notify admin
      await notifyAdmin(appId, threats);
      
      return NextResponse.json({
        success: false,
        status: 'malicious',
        threats,
        results
      });
    }
    
    return NextResponse.json({
      success: true,
      status: 'clean',
      results
    });
    
  } catch (error) {
    console.error('Scan error:', error);
    return NextResponse.json(
      { error: 'Scan failed' },
      { status: 500 }
    );
  }
}

async function scanWithClamAV(buffer) {
  try {
    // Write buffer to temp file
    const tempFile = `/tmp/scan_${Date.now()}.tmp`;
    require('fs').writeFileSync(tempFile, buffer);
    
    const result = await scanner.scanFile(tempFile);
    
    // Clean up
    require('fs').unlinkSync(tempFile);
    
    return result;
  } catch (error) {
    console.error('ClamAV error:', error);
    return { is_infected: false, error: error.message };
  }
}

async function scanWithVirusTotal(fileHash) {
  try {
    const response = await fetch(`https://www.virustotal.com/api/v3/files/${fileHash}`, {
      headers: {
        'x-apikey': process.env.VIRUSTOTAL_API_KEY
      }
    });
    
    if (response.status === 404) {
      // File not in VT database
      return { positives: 0, total: 0, status: 'not_found' };
    }
    
    const data = await response.json();
    
    return {
      positives: data.data.attributes.last_analysis_stats.malicious,
      total: Object.keys(data.data.attributes.last_analysis_results).length,
      engines: data.data.attributes.last_analysis_results
    };
  } catch (error) {
    console.error('VirusTotal error:', error);
    return { positives: 0, total: 0, error: error.message };
  }
}

async function scanWithYARA(buffer) {
  try {
    const compiler = new yara.Compiler();
    await compiler.addString(yaraRules, 'fireos_rules');
    
    const rules = compiler.getRules();
    const scanner = new yara.Scanner();
    
    const result = await scanner.scanBuffer(buffer, { rules });
    
    return {
      matches: result.rules || [],
      scanned: true
    };
  } catch (error) {
    console.error('YARA error:', error);
    return { matches: [], error: error.message };
  }
}

async function heuristicAnalysis(buffer) {
  const suspiciousIndicators = [];
  
  try {
    // Check for APK structure
    const zip = require('jszip');
    const archive = await zip.loadAsync(buffer);
    
    // 1. Check for suspicious file names
    const files = Object.keys(archive.files);
    const suspiciousFiles = files.filter(file => 
      /(malware|virus|exploit|backdoor|trojan|rat|keylogger)/i.test(file) ||
      /\.(so|dex|apk|jar)$/i.test(file) && file.includes('lib') ||
      file.includes('META-INF') && /\.(RSA|DSA|SF)$/.test(file)
    );
    
    if (suspiciousFiles.length > 0) {
      suspiciousIndicators.push(`Suspicious files: ${suspiciousFiles.join(', ')}`);
    }
    
    // 2. Check for embedded executables
    for (const file of files) {
      if (/\.(exe|dll|bat|sh)$/i.test(file)) {
        suspiciousIndicators.push(`Embedded executable: ${file}`);
      }
    }
    
    // 3. Check for obfuscation
    const manifestFile = archive.file('AndroidManifest.xml') || 
                         archive.file('manifest.json');
    
    if (manifestFile) {
      const manifestContent = await manifestFile.async('text');
      
      // Check for excessive permissions
      const permissions = [
        'READ_SMS', 'SEND_SMS', 'RECEIVE_SMS',
        'ACCESS_FINE_LOCATION', 'RECORD_AUDIO',
        'CAMERA', 'READ_CONTACTS', 'READ_CALENDAR'
      ];
      
      const foundPermissions = permissions.filter(p => 
        manifestContent.includes(p)
      );
      
      if (foundPermissions.length > 5) {
        suspiciousIndicators.push(`Excessive permissions: ${foundPermissions.join(', ')}`);
      }
      
      // Check for debuggable flag
      if (manifestContent.includes('android:debuggable="true"')) {
        suspiciousIndicators.push('Debug mode enabled');
      }
    }
    
    // 4. Check file entropy (encryption/obfuscation detection)
    const entropy = calculateEntropy(buffer);
    if (entropy > 7.5) { // High entropy suggests encryption
      suspiciousIndicators.push(`High entropy detected: ${entropy.toFixed(2)}`);
    }
    
    // 5. Check for known bad certificates
    const certFile = archive.file('META-INF/CERT.RSA') || 
                     archive.file('META-INF/CERT.DSA');
    
    if (certFile) {
      const certBuffer = await certFile.async('nodebuffer');
      const certHash = crypto.createHash('sha256').update(certBuffer).digest('hex');
      
      // Check against known malicious certificates
      const knownBadCerts = require('./known_certs.json');
      if (knownBadCerts.includes(certHash)) {
        suspiciousIndicators.push('Known malicious certificate');
      }
    }
    
    return {
      suspicious: suspiciousIndicators.length > 0,
      reasons: suspiciousIndicators,
      entropy,
      file_count: files.length
    };
    
  } catch (error) {
    console.error('Heuristic analysis error:', error);
    return { suspicious: false, error: error.message };
  }
}

function calculateEntropy(buffer) {
  const byteCounts = new Array(256).fill(0);
  const totalBytes = buffer.length;
  
  for (let i = 0; i < totalBytes; i++) {
    byteCounts[buffer[i]]++;
  }
  
  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    if (byteCounts[i] > 0) {
      const probability = byteCounts[i] / totalBytes;
      entropy -= probability * Math.log2(probability);
    }
  }
  
  return entropy;
}

async function notifyAdmin(appId, threats) {
  // Send notification to admin
  await supabase
    .from('admin_notifications')
    .insert({
      type: 'malware_detected',
      app_id: appId,
      threats,
      created_at: new Date().toISOString(),
      priority: 'high'
    });
}
