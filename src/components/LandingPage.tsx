import React, { useState, useEffect } from 'react';
import { User, Session } from '../types';
import { Smartphone, QrCode, Key, CheckCircle, ExternalLink, RefreshCw, Send, AlertCircle, Upload } from 'lucide-react';
import { io } from 'socket.io-client';

interface LandingPageProps {
  onLoginClick: () => void;
  currentUser: User | null;
  authToken: string | null;
  onLogout: () => void;
}

export default function LandingPage({ onLoginClick, currentUser, authToken, onLogout }: LandingPageProps) {
  // Guest session management
  const [localToken, setLocalToken] = useState<string | null>(authToken);
  const [localUser, setLocalUser] = useState<User | null>(currentUser);
  
  // Track deviceId to support multiple devices
  const [currentDeviceId, setCurrentDeviceId] = useState<string>(() => {
    let devId = localStorage.getItem('hijjaze_device_id');
    if (!devId) {
      devId = 'dev_' + Math.random().toString(36).substring(2, 9);
      localStorage.setItem('hijjaze_device_id', devId);
    }
    return devId;
  });

  const [method, setMethod] = useState<'pairing' | 'qr' | 'import'>('pairing');
  const [phone, setPhone] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [qrCodeData, setQrCodeData] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [socket, setSocket] = useState<any>(null);

  // Synchronize when parent login state changes
  useEffect(() => {
    setLocalToken(authToken);
    setLocalUser(currentUser);
  }, [authToken, currentUser]);

  // Silent automatic guest login on mount if not authenticated
  useEffect(() => {
    const initializeSession = async () => {
      if (localToken && localUser) return;

      // Check if guest credentials exist in localStorage
      const cachedToken = localStorage.getItem('hijjaze_guest_token');
      const cachedUser = localStorage.getItem('hijjaze_guest_user');

      if (cachedToken && cachedUser) {
        try {
          const parsedUser = JSON.parse(cachedUser);
          setLocalToken(cachedToken);
          setLocalUser(parsedUser);
          return;
        } catch (e) {
          localStorage.removeItem('hijjaze_guest_token');
          localStorage.removeItem('hijjaze_guest_user');
        }
      }

      // Register a silent guest user
      try {
        setLoading(true);
        const randId = Math.random().toString(36).substring(2, 9);
        const response = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: `guest_${randId}@hijjaze.local`,
            name: `Guest ${randId}`,
            password: `guest_pass_${randId}`
          })
        });

        const data = await response.json();
        if (response.ok && data.token && data.user) {
          localStorage.setItem('hijjaze_guest_token', data.token);
          localStorage.setItem('hijjaze_guest_user', JSON.stringify(data.user));
          setLocalToken(data.token);
          setLocalUser(data.user);
        }
      } catch (err) {
        console.error('Silent guest registration failed:', err);
      } finally {
        setLoading(false);
      }
    };

    initializeSession();
  }, [localToken, localUser]);

  // Handle WhatsApp session state loading and socket connection
  useEffect(() => {
    if (!localToken || !localUser || !currentDeviceId) return;

    let active = true;
    let retryTimeout: any = null;

    // Fetch initial status with deviceId parameter
    const fetchStatus = async () => {
      try {
        const res = await fetch(`/api/whatsapp/status?deviceId=${currentDeviceId}`, {
          headers: { 'Authorization': `Bearer ${localToken}` }
        });
        if (!active) return;

        const data = await res.json();
        if (res.ok) {
          setSession(data);
          if (data.status === 'qr' && data.qr) {
            setQrCodeData(data.qr);
          }
        } else if (res.status === 401 || res.status === 403) {
          // Clear invalid/expired guest tokens to trigger safe guest re-registration or user log in
          console.warn('Authentication token expired or invalid, clearing local session.');
          localStorage.removeItem('hijjaze_guest_token');
          localStorage.removeItem('hijjaze_guest_user');
          if (!authToken) {
            setLocalToken(null);
            setLocalUser(null);
          }
        }
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        if (errMessage.includes('Failed to fetch')) {
          console.warn('Failed to load whatsapp status (will retry):', errMessage);
        } else {
          console.error('Failed to load whatsapp status:', err);
        }
        // Automatically retry status fetching on network failures or server start delays
        if (active) {
          retryTimeout = setTimeout(fetchStatus, 5000);
        }
      }
    };

    fetchStatus();

    // Establish Socket.io client connection for real-time state updates
    const socketUrl = window.location.origin;
    const newSocket = io(socketUrl);
    
    newSocket.on('connect', () => {
      const roomName = `${localUser.id}_${currentDeviceId}`;
      console.log('Real-time updates connected for user device room:', roomName);
      newSocket.emit('join', roomName);
    });

    newSocket.on('wa-status', (waUpdate: any) => {
      console.log('Real-time wa-status update received:', waUpdate);
      setSession(waUpdate);
      if (waUpdate.status === 'qr' && waUpdate.qr) {
        setQrCodeData(waUpdate.qr);
      } else if (waUpdate.status === 'connected') {
        setPairingCode('');
        setQrCodeData('');
      }
    });

    setSocket(newSocket);

    return () => {
      active = false;
      if (retryTimeout) clearTimeout(retryTimeout);
      newSocket.disconnect();
    };
  }, [localToken, localUser, currentDeviceId]);

  // Request Pairing Code
  const handleRequestPairing = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone) {
      setError('Please provide a valid phone number with country code.');
      return;
    }
    setError('');
    setLoading(true);
    setPairingCode('');

    try {
      const response = await fetch('/api/whatsapp/pair', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localToken}`
        },
        body: JSON.stringify({ phone, deviceId: currentDeviceId })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate pairing code');
      }

      setPairingCode(data.code);
    } catch (err: any) {
      setError(err.message || 'Failed to initialize pairing');
    } finally {
      setLoading(false);
    }
  };

  // Start QR Code generation session
  const handleStartQrSession = async () => {
    setError('');
    setLoading(true);
    setQrCodeData('');

    try {
      // Trigger QR socket flow
      await fetch('/api/whatsapp/pair', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localToken}`
        },
        body: JSON.stringify({ phone: '', deviceId: currentDeviceId })
      });
    } catch (err: any) {
      console.log('QR init log:', err);
    } finally {
      setLoading(false);
    }
  };

  // Handle uploaded creds.json file
  const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target?.result as string;
        // Verify JSON parseability
        JSON.parse(text);

        setLoading(true);
        setError('');

        const response = await fetch('/api/whatsapp/import-creds', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localToken}`
          },
          body: JSON.stringify({ credsContent: text, deviceId: currentDeviceId })
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Failed to import WhatsApp credentials');
        }

        // Display temporary connecting state
        setSession({
          userId: `${localUser?.id}_${currentDeviceId}`,
          email: localUser?.email || '',
          status: 'connecting',
          phone: data.phone
        });

      } catch (err: any) {
        setError(err.message || 'Error processing the uploaded creds.json file.');
      } finally {
        setLoading(false);
      }
    };
    reader.readAsText(file);
  };

  // Disconnect WhatsApp session
  const handleDisconnect = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/whatsapp/disconnect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localToken}`
        },
        body: JSON.stringify({ deviceId: currentDeviceId })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to disconnect');
      }
      setSession(null);
      setPairingCode('');
      setQrCodeData('');
    } catch (err: any) {
      setError(err.message || 'Error disconnecting');
    } finally {
      setLoading(false);
    }
  };

  // Link another device (Generate a new unique deviceId to start a new pairing flow)
  const handleLinkAnotherDevice = () => {
    const newDevId = 'dev_' + Math.random().toString(36).substring(2, 9);
    localStorage.setItem('hijjaze_device_id', newDevId);
    setCurrentDeviceId(newDevId);
    setSession(null);
    setPairingCode('');
    setQrCodeData('');
  };

  const isConnected = session?.status === 'connected';
  const isConnecting = session?.status === 'connecting';

  return (
    <div className="relative min-h-[85vh] flex flex-col justify-between py-10 px-4 sm:px-6 lg:px-8">
      {/* Decorative Blur Ambient Elements */}
      <div className="absolute top-1/4 left-1/10 w-96 h-96 bg-emerald-500/5 blur-3xl rounded-full pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/10 w-96 h-96 bg-zinc-500/5 blur-3xl rounded-full pointer-events-none" />

      <div className="max-w-4xl w-full mx-auto space-y-10">
        {/* Main Hero Header */}
        <div className="text-center space-y-4">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full text-xs font-semibold uppercase tracking-wider">
            <span>WhatsApp Session Hub</span>
          </div>
          <h1 id="landing-title" className="text-4xl sm:text-6xl font-black text-zinc-100 tracking-tight font-sans">
            Hijjaze <span className="text-emerald-500">Bot</span>
          </h1>
          <p className="max-w-xl mx-auto text-zinc-400 text-base sm:text-lg">
            Quickly generate active WhatsApp session credentials. Scan the QR code or request an 8-digit pairing code to sync completely.
          </p>
        </div>

        {/* Core Control Panel */}
        <div className="w-full max-w-xl mx-auto bg-zinc-950 border border-zinc-900 rounded-2xl shadow-xl overflow-hidden relative">
          {/* Header Status Bar */}
          <div className="bg-zinc-900/50 border-b border-zinc-900 p-4 flex items-center justify-between">
            <span className="text-sm font-semibold text-zinc-400">Connection Engine</span>
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full ${
                isConnected ? 'bg-emerald-500 animate-pulse' : isConnecting ? 'bg-amber-500 animate-pulse' : 'bg-zinc-700'
              }`} />
              <span className="text-xs uppercase font-mono tracking-wider text-zinc-500">
                {isConnected ? 'Connected' : isConnecting ? 'Connecting' : 'Disconnected'}
              </span>
            </div>
          </div>

          <div className="p-6 sm:p-8 space-y-6">
            {error && (
              <div className="flex items-start gap-2.5 p-4 bg-red-950/20 border border-red-900/50 rounded-xl text-red-400 text-sm">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {isConnected ? (
              /* CONNECTED COMPLETELY SCREEN */
              <div className="py-6 space-y-6 animate-fade-in text-center">
                <div className="w-20 h-20 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mx-auto shadow-lg shadow-emerald-500/5 animate-bounce">
                  <CheckCircle className="w-10 h-10" />
                </div>
                
                <div className="space-y-2">
                  <h3 className="text-2xl font-black text-zinc-100">Connected!</h3>
                  <p className="text-sm text-emerald-400 font-bold tracking-wide">
                    Bot connected! See on your number.
                  </p>
                  <p className="text-xs text-zinc-500 max-w-sm mx-auto leading-relaxed">
                    You can close this tab now or link another device to keep syncing other accounts.
                  </p>
                </div>

                <div className="pt-4 flex flex-col sm:flex-row items-center justify-center gap-3">
                  <button
                    onClick={handleLinkAnotherDevice}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3.5 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black rounded-xl text-xs transition-all shadow-md active:scale-95 cursor-pointer"
                  >
                    <Smartphone className="w-4 h-4" />
                    Link Another Device
                  </button>
                  <button
                    onClick={handleDisconnect}
                    disabled={loading}
                    className="w-full sm:w-auto px-5 py-3.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-red-400 font-bold rounded-xl text-xs border border-zinc-800 transition-all active:scale-95 cursor-pointer"
                  >
                    Disconnect Current Session
                  </button>
                </div>
              </div>
            ) : (
              /* LINKING SETUP SCREEN */
              <div className="space-y-6">
                {/* Mode Selector Tabs */}
                <div className="grid grid-cols-3 p-1 bg-zinc-900 rounded-xl border border-zinc-800/80">
                  <button
                    onClick={() => { setMethod('pairing'); setError(''); }}
                    className={`flex items-center justify-center gap-1 sm:gap-2 py-2.5 rounded-lg text-xs font-semibold transition-all ${
                      method === 'pairing' 
                        ? 'bg-zinc-800 text-emerald-400 shadow-sm' 
                        : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    <Key className="w-3.5 h-3.5" />
                    Pairing Code
                  </button>
                  <button
                    onClick={() => { setMethod('qr'); setError(''); handleStartQrSession(); }}
                    className={`flex items-center justify-center gap-1 sm:gap-2 py-2.5 rounded-lg text-xs font-semibold transition-all ${
                      method === 'qr' 
                        ? 'bg-zinc-800 text-emerald-400 shadow-sm' 
                        : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    <QrCode className="w-3.5 h-3.5" />
                    QR Code Scan
                  </button>
                  <button
                    onClick={() => { setMethod('import'); setError(''); }}
                    className={`flex items-center justify-center gap-1 sm:gap-2 py-2.5 rounded-lg text-xs font-semibold transition-all ${
                      method === 'import' 
                        ? 'bg-zinc-800 text-emerald-400 shadow-sm' 
                        : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    <Upload className="w-3.5 h-3.5" />
                    Import creds
                  </button>
                </div>

                {method === 'pairing' && (
                  /* Pairing Code Setup */
                  <div className="space-y-6 animate-fade-in">
                    <p className="text-sm text-zinc-400">
                      Enter your phone number including country code (e.g., <code className="font-mono text-emerald-400 bg-zinc-900 px-1 py-0.5 rounded">923001234567</code>) to request a temporary linking code.
                    </p>

                    <form onSubmit={handleRequestPairing} className="flex gap-2">
                      <div className="relative flex-1">
                        <Smartphone className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-zinc-600" />
                        <input
                          type="tel"
                          required
                          placeholder="Phone (e.g., 923001234567)"
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          className="w-full pl-11 pr-4 py-3 bg-zinc-900 border border-zinc-800 rounded-xl focus:outline-none focus:border-emerald-500 text-zinc-200 placeholder-zinc-600 text-sm transition-colors"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={loading}
                        className="px-5 bg-emerald-500 hover:bg-emerald-400 disabled:bg-zinc-800 text-zinc-950 disabled:text-zinc-600 font-bold rounded-xl flex items-center gap-2 transition-all active:scale-[0.98]"
                      >
                        {loading ? (
                          <RefreshCw className="w-4.5 h-4.5 animate-spin" />
                        ) : (
                          <>
                            Get Code
                          </>
                        )}
                      </button>
                    </form>

                    {pairingCode && (
                      <div className="p-6 bg-zinc-900/50 border border-zinc-800 rounded-2xl text-center space-y-4">
                        <span className="text-xs font-semibold tracking-wider uppercase text-zinc-500">Your Pairing Code</span>
                        <div className="text-3xl sm:text-4xl font-black font-mono tracking-widest text-emerald-400">
                          {pairingCode}
                        </div>
                        <p className="text-xs text-zinc-400 max-w-xs mx-auto">
                          Open WhatsApp on your device → Linked Devices → Link with Phone Number → Enter this code.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {method === 'qr' && (
                  /* QR Code Setup */
                  <div className="space-y-6 text-center animate-fade-in">
                    <p className="text-sm text-zinc-400">
                      Scan the QR code below using your WhatsApp Linked Devices camera to link instantly.
                    </p>

                    <div className="w-60 h-60 mx-auto bg-zinc-900 border border-zinc-800 rounded-2xl flex items-center justify-center overflow-hidden relative shadow-inner">
                      {qrCodeData ? (
                        <img 
                          src={`https://api.qrserver.com/v1/create-qr-code/?size=240x240&bgcolor=09090b&color=ffffff&data=${encodeURIComponent(qrCodeData)}`}
                          alt="WhatsApp Linking QR Code" 
                          referrerPolicy="no-referrer"
                          className="w-52 h-52 object-contain"
                        />
                      ) : (
                        <div className="flex flex-col items-center justify-center space-y-3">
                          <RefreshCw className="w-8 h-8 text-emerald-400 animate-spin" />
                          <span className="text-xs text-zinc-500 font-mono">Generating QR...</span>
                        </div>
                      )}
                    </div>

                    <button
                      onClick={handleStartQrSession}
                      disabled={loading}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-zinc-200 text-xs font-bold rounded-xl transition-all"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Refresh QR Code
                    </button>
                  </div>
                )}

                {method === 'import' && (
                  /* Import creds.json Setup */
                  <div className="space-y-6 text-center animate-fade-in">
                    <p className="text-sm text-zinc-400 text-left">
                      Upload an existing Baileys <code className="font-mono text-emerald-400 bg-zinc-900 px-1.5 py-0.5 rounded">creds.json</code> file to restore your WhatsApp session instantly without scanning a QR code or pairing code.
                    </p>

                    <div className="border-2 border-dashed border-zinc-800 hover:border-emerald-500/50 rounded-2xl p-8 text-center cursor-pointer transition-all hover:bg-zinc-900/10 relative">
                      <input
                        type="file"
                        accept=".json"
                        onChange={handleImportFileChange}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      />
                      <div className="space-y-3 pointer-events-none">
                        <div className="w-12 h-12 bg-emerald-500/10 text-emerald-400 rounded-full flex items-center justify-center mx-auto">
                          <Upload className="w-6 h-6" />
                        </div>
                        <div className="space-y-1">
                          <p className="text-sm font-semibold text-zinc-300">Click to upload or drag & drop</p>
                          <p className="text-xs text-zinc-500">Supported formats: JSON (creds.json)</p>
                        </div>
                      </div>
                    </div>

                    <div className="text-xs text-zinc-500 text-left bg-zinc-900/40 border border-zinc-900 p-4 rounded-xl space-y-1.5 font-mono">
                      <span className="text-[10px] uppercase font-bold tracking-wider text-emerald-500">Expected File Structure</span>
                      <pre className="text-[10px] overflow-x-auto text-zinc-400 p-2 bg-black/30 rounded">
{`{
  "noiseKey": { ... },
  "pairingEphemeralKeyPair": { ... },
  "signedIdentityKey": { ... },
  ...
}`}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* WhatsApp newsletter/channel Callout */}
        <div className="w-full max-w-xl mx-auto bg-zinc-950/40 border border-zinc-900 rounded-2xl p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-emerald-500/10 text-emerald-400 rounded-xl">
              <Send className="w-5 h-5" />
            </div>
            <div className="space-y-1 text-center sm:text-left">
              <h4 className="text-sm font-bold text-zinc-200">Official Channel Updates</h4>
            </div>
          </div>
          <a
            href="https://whatsapp.com/channel/0029Vb7wo6O5a23w6LJo2K1y"
            target="_blank"
            rel="noopener noreferrer"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-800 hover:bg-zinc-750 text-zinc-200 text-xs font-bold rounded-xl border border-zinc-700/50 transition-all hover:border-zinc-600 animate-pulse"
          >
            View Channel
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>
    </div>
  );
}
