import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import speakeasy from 'speakeasy';
import CryptoJS from 'crypto-js';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import validator from 'validator';
import helmet from 'helmet';
import csurf from 'csurf';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Rate limiting
const rateLimiter = new RateLimiterMemory({
  points: 5, // 5 attempts
  duration: 15 * 60, // 15 minutes
});

// Security middleware
const csrfProtection = csurf({ cookie: true });

export async function POST(request) {
  try {
    // Get client info
    const clientIP = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip');
    const userAgent = request.headers.get('user-agent');
    
    // Rate limit check
    try {
      await rateLimiter.consume(clientIP);
    } catch (rateLimiterRes) {
      return NextResponse.json(
        { error: 'Too many attempts. Try again later.' },
        { status: 429, headers: { 'Retry-After': rateLimiterRes.msBeforeNext / 1000 } }
      );
    }
    
    const body = await request.json();
    
    // Decrypt client-side encrypted password
    const decryptedPassword = CryptoJS.AES.decrypt(
      body.password,
      process.env.ENCRYPTION_KEY
    ).toString(CryptoJS.enc.Utf8);
    
    // Input validation
    if (!validator.isLength(decryptedPassword, { min: 12 })) {
      return NextResponse.json(
        { error: 'Password must be at least 12 characters' },
        { status: 400 }
      );
    }
    
    // Get user from Supabase
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('email', body.email)
      .single();
    
    if (userError || !user) {
      return NextResponse.json(
        { error: 'Invalid credentials' },
        { status: 401 }
      );
    }
    
    // Check if account is locked
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return NextResponse.json(
        { error: 'Account locked. Try again later.' },
        { status: 423 }
      );
    }
    
    // Verify password with bcrypt
    const passwordValid = await bcrypt.compare(decryptedPassword, user.password_hash);
    
    if (!passwordValid) {
      // Increment failed attempts
      await supabase
        .from('users')
        .update({ 
          failed_attempts: (user.failed_attempts || 0) + 1,
          last_failed_attempt: new Date().toISOString()
        })
        .eq('id', user.id);
      
      // Lock account after 5 failed attempts
      if (user.failed_attempts + 1 >= 5) {
        await supabase
          .from('users')
          .update({ 
            locked_until: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 minutes
          })
          .eq('id', user.id);
      }
      
      return NextResponse.json(
        { error: 'Invalid credentials' },
        { status: 401 }
      );
    }
    
    // Verify TOTP if enabled
    if (user.totp_enabled) {
      const totpValid = speakeasy.totp.verify({
        secret: user.totp_secret,
        encoding: 'base32',
        token: body.totp,
        window: 1 // Allow 30 seconds before/after
      });
      
      if (!totpValid) {
        return NextResponse.json(
          { error: 'Invalid two-factor code' },
          { status: 401 }
        );
      }
    }
    
    // Verify biometric if provided
    if (body.biometric) {
      const { data: biometric } = await supabase
        .from('biometric_credentials')
        .select('*')
        .eq('user_id', user.id)
        .eq('credential_id', body.biometric.credentialId)
        .single();
      
      if (!biometric) {
        return NextResponse.json(
          { error: 'Biometric verification failed' },
          { status: 401 }
        );
      }
    }
    
    // Generate JWT token
    const token = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        session_id: CryptoJS.lib.WordArray.random(32).toString()
      },
      process.env.JWT_SECRET,
      {
        expiresIn: '24h',
        issuer: 'fireos',
        audience: 'fireos-web',
        algorithm: 'HS512'
      }
    );
    
    // Create session
    const sessionToken = CryptoJS.lib.WordArray.random(64).toString();
    const sessionHash = CryptoJS.SHA256(sessionToken).toString();
    
    await supabase
      .from('sessions')
      .insert({
        user_id: user.id,
        session_hash: sessionHash,
        ip_address: clientIP,
        user_agent: userAgent,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        device_fingerprint: body.deviceFingerprint,
        location: await getLocation(clientIP)
      });
    
    // Reset failed attempts
    await supabase
      .from('users')
      .update({ 
        failed_attempts: 0,
        last_login: new Date().toISOString(),
        locked_until: null
      })
      .eq('id', user.id);
    
    // Set secure cookies
    const response = NextResponse.json({
      success: true,
      token,
      session: {
        id: sessionHash,
        expires: new Date(Date.now() + 24 * 60 * 60 * 1000)
      },
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatar: user.avatar_url
      }
    });
    
    // HTTP-only secure cookies
    response.cookies.set('fireos_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60,
      path: '/'
    });
    
    response.cookies.set('fireos_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60,
      path: '/'
    });
    
    // Security headers
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('X-XSS-Protection', '1; mode=block');
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    
    return response;
    
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

async function getLocation(ip) {
  try {
    const response = await fetch(`https://ipapi.co/${ip}/json/`);
    const data = await response.json();
    return {
      city: data.city,
      country: data.country_name,
      latitude: data.latitude,
      longitude: data.longitude
    };
  } catch {
    return null;
  }
}
