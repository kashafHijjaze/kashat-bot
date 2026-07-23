import React, { useState, useEffect } from 'react';
import { User, Session, UserProfile, CommandLogRecord } from '../types';
import { 
  Smartphone, CheckCircle, XCircle, LogOut, ShieldAlert, 
  RefreshCw, Download, Send, User as UserIcon, Calendar, Clock, 
  Activity, Sparkles, Image as ImageIcon, Music, Video, Users, 
  Edit3, Search, Shield, Zap, CheckCircle2, AlertCircle, HelpCircle
} from 'lucide-react';
import BotControl from './BotControl';
import { io } from 'socket.io-client';

interface DashboardProps {
  currentUser: User;
  authToken: string;
  onLogout: () => void;
  theme?: 'dark' | 'light';
}

export default function Dashboard({ currentUser, authToken, onLogout, theme = 'dark' }: DashboardProps) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Active tab in dashboard: 'profile' | 'stats' | 'device' | 'control'
  const [activeTab, setActiveTab] = useState<'profile' | 'stats' | 'device' | 'control'>('profile');

  // Edit profile state
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(currentUser.name);
  const [editAvatar, setEditAvatar] = useState('');

  // Search filter for recent commands
  const [commandSearch, setCommandSearch] = useState('');

  // Logout modal confirmation state
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  const fetchProfileAndStatus = async () => {
    try {
      setLoading(true);
      setError('');
      const headers = { 'Authorization': `Bearer ${authToken}` };

      const res = await fetch('/api/user/profile', { headers });
      if (!res.ok) throw new Error('Failed to fetch user profile');

      const data = await res.json();
      setProfile(data.profile);
      setSession(data.session);
      if (data.profile) {
        setEditName(data.profile.name || currentUser.name);
        setEditAvatar(data.profile.avatarUrl || '');
      }
    } catch (err: any) {
      console.error('Error loading dashboard profile:', err);
      setError(err.message || 'Error loading profile data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProfileAndStatus();

    // Establish Socket.io connection for real-time updates
    const socketUrl = window.location.origin;
    const newSocket = io(socketUrl);

    newSocket.on('connect', () => {
      console.log('User dashboard joined real-time socket room:', currentUser.id);
      newSocket.emit('join', currentUser.id);
    });

    newSocket.on('wa-status', (waUpdate: any) => {
      console.log('Realtime wa-status update:', waUpdate);
      setSession(waUpdate);
    });

    // Background silent poll for command stats update
    const pollInterval = setInterval(() => {
      fetch('/api/user/profile', { headers: { 'Authorization': `Bearer ${authToken}` } })
        .then(res => res.json())
        .then(data => {
          if (data.profile) setProfile(data.profile);
          if (data.session) setSession(data.session);
        })
        .catch(() => {});
    }, 10000);

    return () => {
      newSocket.disconnect();
      clearInterval(pollInterval);
    };
  }, [authToken]);

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch('/api/user/profile', {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}` 
        },
        body: JSON.stringify({ name: editName, avatarUrl: editAvatar })
      });

      const data = await res.json();
      if (res.ok) {
        setProfile(data.profile);
        setIsEditing(false);
        setSuccessMsg('Profile details updated successfully');
      } else {
        throw new Error(data.error || 'Failed to update profile');
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDisconnectWhatsApp = async () => {
    if (!window.confirm('Are you sure you want to disconnect your WhatsApp bot session?')) return;
    try {
      setLoading(true);
      const res = await fetch('/api/whatsapp/disconnect', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (res.ok) {
        setSession(null);
        setSuccessMsg('WhatsApp session disconnected successfully');
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to disconnect');
      }
    } catch (err) {
      setError('Error disconnecting session');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmLogout = async () => {
    try {
      await fetch('/api/user/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
    } catch (e) {
      // ignore
    } finally {
      onLogout();
    }
  };

  const isConnected = session?.status === 'connected';

  // Styling based on dark/light theme
  const cardBg = theme === 'dark' ? 'bg-zinc-950/80 border-zinc-900/80 backdrop-blur-xl' : 'bg-white/90 border-zinc-200/90 backdrop-blur-xl';
  const textPrimary = theme === 'dark' ? 'text-zinc-100' : 'text-zinc-800';
  const textSecondary = theme === 'dark' ? 'text-zinc-400' : 'text-zinc-500';

  const userStatus = profile?.status || currentUser.status || 'active';

  // Filter recent commands
  const recentCmds = profile?.recentCommands || [];
  const filteredRecentCmds = recentCmds.filter(c => {
    const term = commandSearch.toLowerCase();
    return (
      c.command.toLowerCase().includes(term) ||
      c.category.toLowerCase().includes(term) ||
      (c.chatName && c.chatName.toLowerCase().includes(term))
    );
  });

  if (loading && !profile) {
    return (
      <div className="max-w-5xl w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-8 animate-pulse select-none">
        <div className={`${cardBg} border rounded-2xl p-6 flex items-center gap-4`}>
          <div className="w-16 h-16 bg-zinc-900 rounded-2xl shrink-0" />
          <div className="space-y-2 flex-1">
            <div className="h-5 w-40 bg-zinc-900 rounded" />
            <div className="h-3 w-60 bg-zinc-900/60 rounded" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-8 animate-fade-in select-none">
      
      {/* Notifications */}
      {error && (
        <div className="flex items-center gap-2.5 p-4 bg-red-950/20 border border-red-900/50 rounded-xl text-red-400 text-sm">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {successMsg && (
        <div className="flex items-center gap-2.5 p-4 bg-emerald-950/20 border border-emerald-900/40 rounded-xl text-emerald-400 text-sm animate-fade-in">
          <CheckCircle2 className="w-5 h-5 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Account Suspended Alert Banner */}
      {userStatus !== 'active' && (
        <div className="flex items-center gap-3 p-4 bg-amber-950/30 border border-amber-500/30 rounded-2xl text-amber-400 text-sm">
          <ShieldAlert className="w-6 h-6 shrink-0 text-amber-500 animate-pulse" />
          <div>
            <span className="font-bold block">Account Status: {userStatus.toUpperCase()}</span>
            <span className="text-xs text-amber-200/80">Your account is currently {userStatus}. Bot commands are disabled until re-enabled by an administrator.</span>
          </div>
        </div>
      )}

      {/* Profile Header Header Box */}
      <div className={`${cardBg} border rounded-2xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-6 shadow-xl relative overflow-hidden`}>
        <div className="absolute top-0 right-0 w-64 h-full bg-emerald-500/5 blur-3xl rounded-full pointer-events-none" />
        
        <div className="flex items-center gap-5 z-10">
          <div className="relative">
            {profile?.avatarUrl ? (
              <img 
                src={profile.avatarUrl} 
                alt="Avatar" 
                className="w-16 h-16 rounded-2xl object-cover border-2 border-emerald-500/20 shadow-lg"
              />
            ) : (
              <div className="w-16 h-16 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-2xl flex items-center justify-center font-black text-2xl uppercase shrink-0 shadow-lg">
                {(profile?.name || currentUser.name).charAt(0)}
              </div>
            )}
            <span className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-zinc-950 ${
              isConnected ? 'bg-emerald-500' : 'bg-zinc-600'
            }`} title={isConnected ? 'WhatsApp Session Connected' : 'Session Offline'} />
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className={`text-xl font-black ${textPrimary}`}>{profile?.name || currentUser.name}</h2>
              <span className={`px-2 py-0.5 text-[10px] font-extrabold uppercase rounded-full border ${
                userStatus === 'active' 
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' 
                  : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
              }`}>
                {userStatus}
              </span>
            </div>
            
            <p className="text-xs text-zinc-500 font-mono tracking-tight flex items-center gap-2">
              <span>{profile?.email || currentUser.email}</span>
              <span>•</span>
              <span className="text-emerald-400 font-bold">{currentUser.role.toUpperCase()}</span>
            </p>

            {session?.phone && (
              <p className="text-xs text-zinc-400 font-mono flex items-center gap-1.5 pt-0.5">
                <Smartphone className="w-3.5 h-3.5 text-emerald-400" />
                <span>WhatsApp: +{session.phone}</span>
              </p>
            )}
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 z-10">
          <button
            onClick={() => setIsEditing(!isEditing)}
            className="flex items-center gap-1.5 px-3.5 py-2.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-bold rounded-xl border border-zinc-800 transition-all active:scale-95"
          >
            <Edit3 className="w-3.5 h-3.5" />
            Edit Profile
          </button>
          <button
            onClick={() => setShowLogoutConfirm(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-zinc-900 hover:bg-red-500/10 text-zinc-400 hover:text-red-400 text-xs font-bold rounded-xl border border-zinc-800 hover:border-red-500/20 transition-all active:scale-95 shadow-md"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </div>

      {/* Edit Profile Form drawer */}
      {isEditing && (
        <form onSubmit={handleUpdateProfile} className={`${cardBg} border rounded-2xl p-6 space-y-4 animate-fade-in`}>
          <h3 className={`text-sm font-bold ${textPrimary} flex items-center gap-2`}>
            <Edit3 className="w-4 h-4 text-emerald-400" />
            Update Profile Information
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400 font-bold">Display Name</label>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                required
                className="w-full px-3.5 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-zinc-200 text-xs focus:outline-none focus:border-emerald-500 transition-colors"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400 font-bold">Avatar Image URL (Optional)</label>
              <input
                type="url"
                placeholder="https://example.com/avatar.jpg"
                value={editAvatar}
                onChange={(e) => setEditAvatar(e.target.value)}
                className="w-full px-3.5 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-zinc-200 text-xs focus:outline-none focus:border-emerald-500 transition-colors"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsEditing(false)}
              className="px-4 py-2 bg-zinc-900 text-zinc-400 text-xs font-bold rounded-xl border border-zinc-800 hover:bg-zinc-800 transition-all"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-extrabold rounded-xl transition-all shadow-md active:scale-95"
            >
              Save Profile Changes
            </button>
          </div>
        </form>
      )}

      {/* Tabs Switcher */}
      <div className="flex flex-wrap gap-2 border-b border-zinc-900 pb-px">
        <button
          onClick={() => setActiveTab('profile')}
          className={`flex items-center gap-2 px-5 py-3 border-b-2 text-xs font-bold transition-all ${
            activeTab === 'profile'
              ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5'
              : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <UserIcon className="w-4 h-4" />
          User Profile Info
        </button>

        <button
          onClick={() => setActiveTab('stats')}
          className={`flex items-center gap-2 px-5 py-3 border-b-2 text-xs font-bold transition-all ${
            activeTab === 'stats'
              ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5'
              : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <Activity className="w-4 h-4" />
          Usage Statistics ({profile?.totalCommands || 0})
        </button>

        <button
          onClick={() => setActiveTab('device')}
          className={`flex items-center gap-2 px-5 py-3 border-b-2 text-xs font-bold transition-all ${
            activeTab === 'device'
              ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5'
              : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <Smartphone className="w-4 h-4" />
          WhatsApp Gateway ({isConnected ? 'Active' : 'Offline'})
        </button>

        <button
          onClick={() => setActiveTab('control')}
          className={`flex items-center gap-2 px-5 py-3 border-b-2 text-xs font-bold transition-all ${
            activeTab === 'control'
              ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5'
              : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <Zap className="w-4 h-4" />
          Bot Custom Controls
        </button>
      </div>

      {/* TAB 1: USER PROFILE INFORMATION */}
      {activeTab === 'profile' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className={`${cardBg} border rounded-2xl p-6 space-y-5 shadow-lg`}>
            <h3 className={`text-base font-bold ${textPrimary} flex items-center gap-2`}>
              <UserIcon className="w-5 h-5 text-emerald-400" />
              Account & Profile Meta
            </h3>

            <div className="space-y-4 text-xs">
              <div className="flex items-center justify-between p-3 bg-zinc-900/40 rounded-xl border border-zinc-900">
                <span className="text-zinc-500 flex items-center gap-2">
                  <Shield className="w-4 h-4 text-zinc-400" /> User Identifier
                </span>
                <span className="font-mono font-bold text-zinc-300">{profile?.userId || currentUser.id}</span>
              </div>

              <div className="flex items-center justify-between p-3 bg-zinc-900/40 rounded-xl border border-zinc-900">
                <span className="text-zinc-500 flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-zinc-400" /> Registration Date
                </span>
                <span className="font-mono text-zinc-300">
                  {profile?.registrationDate ? new Date(profile.registrationDate).toLocaleDateString() : 'N/A'}
                </span>
              </div>

              <div className="flex items-center justify-between p-3 bg-zinc-900/40 rounded-xl border border-zinc-900">
                <span className="text-zinc-500 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-zinc-400" /> Last Web Login
                </span>
                <span className="font-mono text-zinc-300">
                  {profile?.lastLogin ? new Date(profile.lastLogin).toLocaleString() : 'N/A'}
                </span>
              </div>

              <div className="flex items-center justify-between p-3 bg-zinc-900/40 rounded-xl border border-zinc-900">
                <span className="text-zinc-500 flex items-center gap-2">
                  <Activity className="w-4 h-4 text-zinc-400" /> Last Active Time
                </span>
                <span className="font-mono text-zinc-300">
                  {profile?.lastActive ? new Date(profile.lastActive).toLocaleString() : 'Just now'}
                </span>
              </div>

              <div className="flex items-center justify-between p-3 bg-zinc-900/40 rounded-xl border border-zinc-900">
                <span className="text-zinc-500 flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-zinc-400" /> Account Status
                </span>
                <span className="font-bold text-emerald-400 uppercase">{userStatus}</span>
              </div>
            </div>
          </div>

          <div className={`${cardBg} border rounded-2xl p-6 space-y-5 shadow-lg flex flex-col justify-between`}>
            <div className="space-y-3">
              <h3 className={`text-base font-bold ${textPrimary} flex items-center gap-2`}>
                <Smartphone className="w-5 h-5 text-emerald-400" />
                Linked WhatsApp Identity
              </h3>
              <p className="text-xs text-zinc-400 leading-relaxed">
                When you link your WhatsApp phone via QR or pairing code, your profile automatically synchronizes your phone number and bot activities.
              </p>
            </div>

            <div className="p-4 bg-zinc-900/40 rounded-xl border border-zinc-900 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-500">WhatsApp Phone Number:</span>
                <span className="font-mono font-bold text-zinc-200">{session?.phone ? `+${session.phone}` : 'Not Linked'}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-500">Connection Status:</span>
                <span className={`font-mono font-bold uppercase ${isConnected ? 'text-emerald-400' : 'text-zinc-500'}`}>
                  {isConnected ? 'Active & Connected' : 'Offline'}
                </span>
              </div>
            </div>

            <div className="pt-2">
              <a
                href="https://whatsapp.com/channel/0029Vb7wo6O5a23w6LJo2K1y"
                target="_blank"
                rel="noreferrer"
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 rounded-xl text-xs font-bold transition-all"
              >
                <Send className="w-3.5 h-3.5" />
                Join Official Updates Channel
              </a>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: USAGE STATISTICS & TELEMETRY */}
      {activeTab === 'stats' && (
        <div className="space-y-6">
          {/* Metrics Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            
            <div className="bg-zinc-950/80 border border-zinc-900 rounded-2xl p-4 space-y-1 shadow-md">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Total Commands</span>
              <div className="text-2xl font-black text-zinc-100">{profile?.totalCommands || 0}</div>
            </div>

            <div className="bg-zinc-950/80 border border-zinc-900 rounded-2xl p-4 space-y-1 shadow-md">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Most Used Command</span>
              <div className="text-base font-bold font-mono text-emerald-400 truncate">
                {profile?.mostUsedCommand ? `.${profile.mostUsedCommand}` : 'None'}
              </div>
            </div>

            <div className="bg-zinc-950/80 border border-zinc-900 rounded-2xl p-4 space-y-1 shadow-md">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">AI Requests</span>
              <div className="text-2xl font-black text-purple-400">{profile?.totalAiRequests || 0}</div>
            </div>

            <div className="bg-zinc-950/80 border border-zinc-900 rounded-2xl p-4 space-y-1 shadow-md">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Media Downloads</span>
              <div className="text-2xl font-black text-blue-400">{profile?.totalDownloads || 0}</div>
              <span className="text-[10px] text-zinc-500 block">
                🎵 {profile?.totalAudioDownloads || 0} MP3 • 🎬 {profile?.totalVideoDownloads || 0} MP4
              </span>
            </div>

            <div className="bg-zinc-950/80 border border-zinc-900 rounded-2xl p-4 space-y-1 shadow-md">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Images & Stickers</span>
              <div className="text-2xl font-black text-amber-400">{profile?.totalImagesGenerated || 0}</div>
            </div>

            <div className="bg-zinc-950/80 border border-zinc-900 rounded-2xl p-4 space-y-1 shadow-md">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Last Used Command</span>
              <div className="text-base font-bold font-mono text-zinc-200 truncate">
                {profile?.lastUsedCommand ? `.${profile.lastUsedCommand}` : 'None'}
              </div>
            </div>

            <div className="bg-zinc-950/80 border border-zinc-900 rounded-2xl p-4 space-y-1 shadow-md col-span-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Last Command Date & Time</span>
              <div className="text-xs font-mono font-bold text-zinc-300 pt-1">
                {profile?.lastCommandTime ? new Date(profile.lastCommandTime).toLocaleString() : 'No command used yet'}
              </div>
            </div>

          </div>

          {/* Recent Commands Feed Table */}
          <div className={`${cardBg} border rounded-2xl p-6 space-y-4 shadow-lg`}>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-0.5">
                <h3 className={`text-base font-bold ${textPrimary}`}>Recently Used Commands</h3>
                <p className="text-xs text-zinc-500">Automatic real-time log of your last 20 executed commands on WhatsApp.</p>
              </div>

              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Filter commands..."
                  value={commandSearch}
                  onChange={(e) => setCommandSearch(e.target.value)}
                  className="pl-9 pr-4 py-1.5 bg-zinc-900 border border-zinc-800 rounded-xl text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 transition-colors"
                />
              </div>
            </div>

            {filteredRecentCmds.length === 0 ? (
              <div className="p-8 text-center text-zinc-500 text-xs space-y-1">
                <Activity className="w-8 h-8 mx-auto text-zinc-700" />
                <p>No recent commands recorded yet. Use your WhatsApp bot to start logging!</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs text-zinc-400">
                  <thead className="bg-zinc-900/50 text-zinc-500 uppercase text-[10px] font-bold">
                    <tr>
                      <th className="p-3">Command</th>
                      <th className="p-3">Category</th>
                      <th className="p-3">Timestamp</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-900">
                    {filteredRecentCmds.map((c, idx) => (
                      <tr key={idx} className="hover:bg-zinc-900/20 transition-colors font-mono">
                        <td className="p-3 font-bold text-emerald-400">.{c.command}</td>
                        <td className="p-3">
                          <span className="px-2 py-0.5 text-[9px] font-bold uppercase rounded bg-zinc-900 text-zinc-300 border border-zinc-800">
                            {c.category}
                          </span>
                        </td>
                        <td className="p-3 text-zinc-500">{new Date(c.timestamp).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: WHATSAPP GATEWAY & DEVICE */}
      {activeTab === 'device' && (
        <div className={`${cardBg} border rounded-2xl p-6 space-y-6 shadow-xl`}>
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-xs font-bold uppercase tracking-wider text-zinc-500">WhatsApp Gateway</span>
              <h3 className={`text-lg font-bold ${textPrimary}`}>Device Session Status</h3>
            </div>
            <button
              onClick={fetchProfileAndStatus}
              className="p-2 text-zinc-500 hover:text-zinc-200 transition-colors bg-zinc-900 hover:bg-zinc-800 rounded-xl border border-zinc-800"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>

          <div className="bg-zinc-900/40 border border-zinc-850 p-4 rounded-xl flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`p-3 rounded-xl ${isConnected ? 'bg-emerald-500/10 text-emerald-400' : 'bg-zinc-800 text-zinc-500'}`}>
                <Smartphone className="w-6 h-6" />
              </div>
              <div className="space-y-0.5">
                <span className={`text-sm font-bold ${textPrimary}`}>
                  {isConnected ? `Phone: +${session?.phone}` : 'No Linked Device'}
                </span>
                <p className="text-xs text-zinc-500 font-mono">
                  {isConnected ? `Status: Active / Connected` : 'Pair your device on the home page'}
                </p>
              </div>
            </div>

            <span className={`px-3 py-1 text-xs font-bold font-mono uppercase rounded-full ${
              isConnected ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-zinc-850 text-zinc-500'
            }`}>
              {isConnected ? 'Active' : 'Offline'}
            </span>
          </div>

          {isConnected && (
            <div className="flex flex-col sm:flex-row items-center justify-end gap-3 pt-4 border-t border-zinc-900">
              <a
                href={`/api/whatsapp/download-creds?token=${authToken}`}
                target="_blank"
                rel="noreferrer"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold rounded-xl text-xs transition-all shadow-md active:scale-95"
              >
                <Download className="w-4 h-4" />
                Download Credentials (creds.json)
              </a>
              <button
                onClick={handleDisconnectWhatsApp}
                className="w-full sm:w-auto px-5 py-2.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 font-bold rounded-xl text-xs border border-red-500/20 transition-all active:scale-95"
              >
                Disconnect WhatsApp Session
              </button>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: BOT CUSTOM CONTROLS */}
      {activeTab === 'control' && (
        <BotControl authToken={authToken} isConnected={isConnected} />
      )}

      {/* LOGOUT CONFIRMATION MODAL */}
      {showLogoutConfirm && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-6 max-w-md w-full space-y-5 shadow-2xl">
            <div className="flex items-center gap-3 text-red-400">
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl">
                <LogOut className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-zinc-100">Sign Out of Dashboard</h3>
                <p className="text-xs text-zinc-500">Confirm UI logout session</p>
              </div>
            </div>

            <p className="text-xs text-zinc-400 leading-relaxed bg-zinc-900/50 p-3.5 rounded-xl border border-zinc-900">
              This action will sign you out of this Web Dashboard interface. <strong className="text-zinc-200">Your linked WhatsApp Bot session will remain active and running in the background.</strong>
            </p>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowLogoutConfirm(false)}
                className="px-4 py-2.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 text-xs font-bold rounded-xl border border-zinc-800 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmLogout}
                className="px-5 py-2.5 bg-red-500 hover:bg-red-400 text-zinc-950 text-xs font-black rounded-xl transition-all shadow-md active:scale-95"
              >
                Confirm Sign Out
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
