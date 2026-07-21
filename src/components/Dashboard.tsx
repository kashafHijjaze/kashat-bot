import React, { useState, useEffect } from 'react';
import { User, Session } from '../types';
import { Smartphone, CheckCircle, XCircle, LogOut, MessageSquare, ShieldAlert, ArrowRight, RefreshCw, Download, ExternalLink, Send } from 'lucide-react';
import BotControl from './BotControl';
import { io } from 'socket.io-client';

interface DashboardProps {
  currentUser: User;
  authToken: string;
  onLogout: () => void;
  theme?: 'dark' | 'light';
}

export default function Dashboard({ currentUser, authToken, onLogout, theme = 'dark' }: DashboardProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [socket, setSocket] = useState<any>(null);

  const fetchSessionStatus = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/whatsapp/status', {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const data = await res.json();
      if (res.ok) {
        setSession(data);
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      if (errMessage.includes('Failed to fetch')) {
        console.warn('Error fetching session (transient):', errMessage);
      } else {
        console.error('Error fetching session:', err);
      }
      setError('Could not retrieve connection status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSessionStatus();

    // Establish Socket.io connection for real-time updates
    const socketUrl = window.location.origin;
    const newSocket = io(socketUrl);

    newSocket.on('connect', () => {
      console.log('User dashboard joined real-time updates for room:', currentUser.id);
      newSocket.emit('join', currentUser.id);
    });

    newSocket.on('wa-status', (waUpdate: any) => {
      console.log('Dashboard wa-status real-time update:', waUpdate);
      setSession(waUpdate);
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, [authToken]);

  const handleDisconnect = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/whatsapp/disconnect', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (res.ok) {
        setSession(null);
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

  const isConnected = session?.status === 'connected';

  // Card background styling based on dark/light theme
  const cardBg = theme === 'dark' ? 'bg-zinc-950 border-zinc-900' : 'bg-white border-zinc-200';
  const textPrimary = theme === 'dark' ? 'text-zinc-100' : 'text-zinc-800';
  const textSecondary = theme === 'dark' ? 'text-zinc-400' : 'text-zinc-500';

  const skeletonMain = theme === 'dark' ? 'bg-zinc-905 bg-zinc-900' : 'bg-zinc-200';
  const skeletonSub = theme === 'dark' ? 'bg-zinc-950/50 bg-zinc-900/50' : 'bg-zinc-100';

  if (loading && !session) {
    return (
      <div className="max-w-4xl w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-8 animate-pulse">
        {/* Profile Header Skeleton */}
        <div className={`${cardBg} border rounded-2xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-6`}>
          <div className="flex items-center gap-4">
            <div className={`w-14 h-14 ${skeletonMain} rounded-xl shrink-0`}></div>
            <div className="space-y-2">
              <div className={`h-5 w-32 ${skeletonMain} rounded-md`}></div>
              <div className={`h-3.5 w-48 ${skeletonSub} rounded-md`}></div>
            </div>
          </div>
          <div className={`h-10 w-24 ${skeletonMain} rounded-xl`}></div>
        </div>

        {/* Grid Dashboard Skeleton */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Device Linked Metric Skeleton */}
          <div className={`${cardBg} border rounded-2xl p-6 space-y-4`}>
            <div className={`h-3 w-28 ${skeletonSub} rounded-md`}></div>
            <div className={`h-10 w-16 ${skeletonMain} rounded-md`}></div>
            <div className="space-y-2">
              <div className={`h-3 w-full ${skeletonSub} rounded-md`}></div>
              <div className={`h-3 w-5/6 ${skeletonSub} rounded-md`}></div>
            </div>
            <div className="pt-2">
              <div className={`h-8 w-full ${skeletonSub} rounded-xl`}></div>
            </div>
          </div>

          {/* Device Connection Status Panel Skeleton */}
          <div className={`md:col-span-2 ${cardBg} border rounded-2xl p-6 flex flex-col justify-between gap-6`}>
            <div className="flex items-start justify-between">
              <div className="space-y-2">
                <div className={`h-3 w-28 ${skeletonSub} rounded-md`}></div>
                <div className={`h-5 w-44 ${skeletonMain} rounded-md`}></div>
              </div>
              <div className={`h-7 w-7 ${skeletonSub} rounded-lg`}></div>
            </div>

            <div className="p-4 rounded-xl bg-zinc-900/10 border border-zinc-200/10 dark:bg-zinc-900/40 dark:border-zinc-900 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`p-2 ${skeletonMain} rounded-lg w-9 h-9`}></div>
                <div className="space-y-2">
                  <div className={`h-4 w-36 ${skeletonMain} rounded-md`}></div>
                  <div className={`h-3 w-56 ${skeletonSub} rounded-md`}></div>
                </div>
              </div>
              <div className={`h-6 w-16 ${skeletonMain} rounded-full`}></div>
            </div>

            <div className="space-y-3 pt-2">
              <div className={`h-3 w-1/3 ${skeletonSub} rounded-md`}></div>
              <div className={`h-3 w-1/2 ${skeletonSub} rounded-md`}></div>
            </div>
          </div>
        </div>

        {/* Bot Control Panel Skeleton */}
        <div className={`${cardBg} border rounded-2xl p-6 space-y-6`}>
          <div className="space-y-2">
            <div className={`h-3 w-28 ${skeletonSub} rounded-md`}></div>
            <div className={`h-5 w-48 ${skeletonMain} rounded-md`}></div>
          </div>
          <div className="space-y-4">
            <div className={`h-10 w-full ${skeletonSub} rounded-xl`}></div>
            <div className={`h-24 w-full ${skeletonSub} rounded-xl`}></div>
            <div className={`h-10 w-32 ${skeletonMain} rounded-xl ml-auto`}></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-8 animate-fade-in">
      {/* Profile Header */}
      <div className={`${cardBg} border rounded-2xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-6 transition-colors duration-200`}>
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-xl flex items-center justify-center font-bold text-xl uppercase shrink-0 shadow-md">
            {currentUser.name.charAt(0)}
          </div>
          <div className="space-y-1">
            <h2 className={`text-xl font-bold ${textPrimary}`}>{currentUser.name}</h2>
            <p className="text-xs text-zinc-500 font-mono tracking-tight">{currentUser.email} • {currentUser.role.toUpperCase()}</p>
          </div>
        </div>
        <button
          onClick={onLogout}
          className={`flex items-center justify-center gap-2 px-4 py-2.5 ${theme === 'dark' ? 'bg-zinc-900 hover:bg-zinc-850 border-zinc-850 hover:border-zinc-800' : 'bg-zinc-100 hover:bg-zinc-200 border-zinc-250 hover:border-zinc-300'} text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 text-sm font-semibold rounded-xl border transition-all shadow-md`}
        >
          <LogOut className="w-4 h-4" />
          Logout
        </button>
      </div>

      {/* Grid Dashboard */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Device Linked Metric */}
        <div className={`${cardBg} border rounded-2xl p-6 space-y-4 transition-colors duration-200`}>
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Device Linkages</span>
          <div className="flex items-baseline gap-2">
            <span className={`text-4xl font-black ${textPrimary}`}>{isConnected ? '1' : '0'}</span>
            <span className="text-sm text-zinc-500">active device</span>
          </div>
          <div className="text-xs text-zinc-500 font-sans leading-relaxed">
            Standard users can bind one active phone at a time to their testing profile.
          </div>
          <div className="pt-2">
            <a
              href="https://whatsapp.com/channel/0029Vb7wo6O5a23w6LJo2K1y"
              target="_blank"
              rel="noopener noreferrer"
              className={`w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-emerald-500/5 hover:bg-emerald-500/10 text-emerald-400 border border-emerald-500/10 hover:border-emerald-500/20 text-xs font-semibold rounded-xl transition-all`}
            >
              <Send className="w-3.5 h-3.5" />
              View Updates Channel
            </a>
          </div>
        </div>

        {/* Device Connection Status Panel */}
        <div className={`md:col-span-2 ${cardBg} border rounded-2xl p-6 flex flex-col justify-between gap-6 transition-colors duration-200`}>
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">WhatsApp Gateway</span>
              <h3 className={`text-lg font-bold ${textPrimary}`}>Linked Device Details</h3>
            </div>
            <button
              onClick={fetchSessionStatus}
              className="p-1.5 text-zinc-500 hover:text-zinc-300 transition-colors hover:bg-zinc-900/50 rounded-lg"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>

          <div className="bg-zinc-900/10 border border-zinc-200/10 dark:bg-zinc-900/40 dark:border-zinc-900 p-4 rounded-xl flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${isConnected ? 'bg-emerald-500/10 text-emerald-400' : 'bg-zinc-800 text-zinc-500'}`}>
                <Smartphone className="w-5 h-5" />
              </div>
              <div className="space-y-0.5">
                <span className={`text-sm font-bold ${textPrimary}`}>
                  {isConnected ? `Phone: +${session?.phone}` : 'No Linked Device'}
                </span>
                <p className="text-xs text-zinc-500 font-mono">
                  {isConnected ? `Status: Active / Connected` : 'Please link your device from the main page'}
                </p>
              </div>
            </div>

            <span className={`px-2.5 py-1 text-xs font-semibold font-mono uppercase rounded-full ${
              isConnected ? 'bg-emerald-500/10 text-emerald-400' : 'bg-zinc-850 text-zinc-500'
            }`}>
              {isConnected ? 'Active' : 'Offline'}
            </span>
          </div>

          {isConnected && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-zinc-200/10 dark:border-zinc-900 text-xs text-zinc-500">
              <div className="space-y-1">
                <span className="block text-[10px] uppercase font-bold text-zinc-500">Session ID</span>
                <span className={`font-mono ${textSecondary} block`}>{currentUser.id}</span>
              </div>
              <div className="space-y-1">
                <span className="block text-[10px] uppercase font-bold text-zinc-500">Device Information</span>
                <span className={`${textSecondary} block`}>Mac OS • Chrome Browser</span>
              </div>
              <div className="space-y-1">
                <span className="block text-[10px] uppercase font-bold text-zinc-500">Connection Time</span>
                <span className={`font-mono ${textSecondary} block`}>
                  {session?.pairedAt ? new Date(session.pairedAt).toLocaleString() : 'N/A'}
                </span>
              </div>
            </div>
          )}

          {isConnected && (
            <div className="flex flex-col sm:flex-row items-center justify-end gap-3 pt-4 border-t border-zinc-200/10 dark:border-zinc-900">
              <a
                href={`/api/whatsapp/download-creds?token=${authToken}`}
                target="_blank"
                rel="noreferrer"
                className={`w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold rounded-xl text-xs transition-all shadow-md active:scale-[0.98]`}
              >
                <Download className="w-3.5 h-3.5" />
                Download creds.json
              </a>
              <button
                onClick={handleDisconnect}
                className="w-full sm:w-auto px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 font-bold rounded-xl text-xs border border-red-500/20 hover:border-red-500/30 transition-all"
              >
                Disconnect Session
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Bot Control Panel (Sending Message Utility) */}
      <BotControl authToken={authToken} isConnected={isConnected} />
    </div>
  );
}
