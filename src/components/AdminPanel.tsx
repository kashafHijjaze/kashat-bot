import React, { useState, useEffect } from 'react';
import { User, Session, SystemLog } from '../types';
import { 
  Shield, Users, Smartphone, FileText, Database, ShieldAlert, LogOut, 
  Trash2, Power, Download, RefreshCw, AlertCircle, Search, Filter, 
  Activity, CheckCircle2, XCircle, HardDrive, Clock, HelpCircle
} from 'lucide-react';
import { io } from 'socket.io-client';

interface AdminPanelProps {
  currentUser: User;
  authToken: string;
  onLogout: () => void;
}

export default function AdminPanel({ currentUser, authToken, onLogout }: AdminPanelProps) {
  const [activeTab, setActiveTab] = useState<'sessions' | 'users' | 'logs' | 'backup'>('sessions');
  const [users, setUsers] = useState<User[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [logs, setLogs] = useState<SystemLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Filtering states
  const [sessionSearch, setSessionSearch] = useState('');
  const [sessionFilter, setSessionFilter] = useState<'all' | 'connected' | 'connecting' | 'disconnected'>('all');
  const [userSearch, setUserSearch] = useState('');
  const [logSearch, setLogSearch] = useState('');

  // Fetch full datasets
  const loadAdminData = async () => {
    setLoading(true);
    setError('');
    setSuccessMsg('');
    try {
      const headers = { 'Authorization': `Bearer ${authToken}` };

      const [usersRes, sessionsRes, logsRes] = await Promise.all([
        fetch('/api/admin/users', { headers }),
        fetch('/api/admin/sessions', { headers }),
        fetch('/api/admin/logs', { headers })
      ]);

      if (!usersRes.ok || !sessionsRes.ok || !logsRes.ok) {
        throw new Error('Failed to retrieve full administrator dataset');
      }

      const usersData = await usersRes.json();
      const sessionsData = await sessionsRes.json();
      const logsData = await logsRes.json();

      setUsers(usersData);
      setSessions(sessionsData);
      setLogs(logsData);
    } catch (err: any) {
      setError(err.message || 'Error occurred while loading admin panels');
    } finally {
      setLoading(false);
    }
  };

  // Silent update function for real-time background syncing
  const loadAdminDataSilent = async () => {
    try {
      const headers = { 'Authorization': `Bearer ${authToken}` };
      const [usersRes, sessionsRes, logsRes] = await Promise.all([
        fetch('/api/admin/users', { headers }),
        fetch('/api/admin/sessions', { headers }),
        fetch('/api/admin/logs', { headers })
      ]);
      if (usersRes.ok && sessionsRes.ok && logsRes.ok) {
        setUsers(await usersRes.json());
        setSessions(await sessionsRes.json());
        setLogs(await logsRes.json());
      }
    } catch (e) {
      console.warn('Silent background sync warning:', e);
    }
  };

  // Initialize socket connections and periodic polling
  useEffect(() => {
    loadAdminData();

    const socketUrl = window.location.origin;
    const newSocket = io(socketUrl);

    newSocket.on('connect', () => {
      console.log('Admin Panel connected to real-time socket updates');
      newSocket.emit('join', 'admin');
    });

    // Real-time WhatsApp Session Updates
    newSocket.on('admin-session-update', (update: any) => {
      console.log('Socket event [admin-session-update]:', update);
      setSessions((prevSessions) => {
        const index = prevSessions.findIndex((s) => s.userId === update.userId);
        if (index !== -1) {
          const next = [...prevSessions];
          next[index] = update;
          return next;
        } else {
          return [...prevSessions, update];
        }
      });
      // Perform a silent refresh to ensure integrity with DB
      loadAdminDataSilent();
    });

    // Real-time Log Updates
    newSocket.on('admin-log-update', (newLog: SystemLog) => {
      console.log('Socket event [admin-log-update]:', newLog);
      setLogs((prevLogs) => [newLog, ...prevLogs]);
    });

    // Fallback polling to ensure consistency
    const pollInterval = setInterval(() => {
      loadAdminDataSilent();
    }, 15000);

    return () => {
      newSocket.disconnect();
      clearInterval(pollInterval);
    };
  }, [authToken]);

  const handleDisconnectSession = async (userId: string, email: string) => {
    if (!window.confirm(`Are you sure you want to terminate the WhatsApp session for ${email}?`)) return;
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`/api/admin/sessions/${userId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const data = await res.json();
      if (res.ok) {
        setSuccessMsg(`Session terminated successfully for ${email}`);
        loadAdminData();
      } else {
        throw new Error(data.error || 'Failed to disconnect session');
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleToggleRole = async (userId: string, email: string) => {
    if (userId === currentUser.id) {
      alert("You cannot revoke your own administrator privileges.");
      return;
    }
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`/api/admin/users/${userId}/toggle-role`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const data = await res.json();
      if (res.ok) {
        setSuccessMsg(`Role toggled successfully for ${email}`);
        loadAdminData();
      } else {
        throw new Error(data.error || 'Failed to toggle user role');
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  // Analytics helper metrics
  const activeSessCount = sessions.filter(s => s.status === 'connected').length;
  const connectingSessCount = sessions.filter(s => s.status === 'connecting').length;
  const inactiveSessCount = sessions.filter(s => s.status !== 'connected' && s.status !== 'connecting').length;
  const totalUsersCount = users.length;
  const guestUsersCount = users.filter(u => u.email.includes('guest_')).length;

  // Filter lists
  const filteredSessions = sessions.filter((sess) => {
    const term = sessionSearch.toLowerCase();
    const matchesSearch = 
      sess.email.toLowerCase().includes(term) || 
      (sess.phone && sess.phone.includes(term)) ||
      sess.userId.toLowerCase().includes(term);
    const matchesFilter = sessionFilter === 'all' || sess.status === sessionFilter;
    return matchesSearch && matchesFilter;
  });

  const filteredUsers = users.filter((u) => {
    const term = userSearch.toLowerCase();
    return (
      u.name.toLowerCase().includes(term) ||
      u.email.toLowerCase().includes(term) ||
      u.id.toLowerCase().includes(term) ||
      u.role.toLowerCase().includes(term)
    );
  });

  const filteredLogs = logs.filter((log) => {
    const term = logSearch.toLowerCase();
    return (
      log.email.toLowerCase().includes(term) ||
      log.action.toLowerCase().includes(term) ||
      log.message.toLowerCase().includes(term) ||
      log.id.toLowerCase().includes(term)
    );
  });

  return (
    <div className="max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-8 animate-fade-in select-none">
      
      {/* Admin Panel Header */}
      <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-6 relative overflow-hidden shadow-xl">
        <div className="absolute top-0 right-0 w-64 h-full bg-red-500/5 blur-3xl rounded-full pointer-events-none" />
        <div className="flex items-center gap-4 z-10">
          <div className="w-14 h-14 bg-red-500/10 text-red-400 border border-red-500/20 rounded-xl flex items-center justify-center shadow-lg">
            <Shield className="w-7 h-7" />
          </div>
          <div className="space-y-1">
            <h2 className="text-xl font-bold text-zinc-100 flex items-center gap-2">
              Hijjaze Bot Master Console
            </h2>
            <p className="text-xs text-zinc-500 font-mono tracking-tight">Logged in as {currentUser.email} • System Control privileges</p>
          </div>
        </div>

        <div className="flex items-center gap-2 z-10">
          <button
            onClick={loadAdminData}
            disabled={loading}
            className="p-2.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-800 rounded-xl transition-all shadow-md active:scale-95"
            title="Force refresh database state"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={onLogout}
            className="flex items-center gap-2 px-4 py-2.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-red-400 text-sm font-bold rounded-xl border border-zinc-800 hover:border-zinc-700 transition-all shadow-md active:scale-95"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </div>

      {/* Real-time Analytics Dashboard Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        
        {/* Metric Card: WhatsApp Linkages */}
        <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-5 flex items-center gap-4 shadow-md">
          <div className="p-3 bg-emerald-500/10 text-emerald-400 border border-emerald-500/15 rounded-xl">
            <Smartphone className="w-5 h-5" />
          </div>
          <div className="space-y-0.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Linked WhatsApps</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-black text-zinc-100">{activeSessCount}</span>
              <span className="text-xs text-zinc-500">active now</span>
            </div>
          </div>
        </div>

        {/* Metric Card: Connected Users */}
        <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-5 flex items-center gap-4 shadow-md">
          <div className="p-3 bg-blue-500/10 text-blue-400 border border-blue-500/15 rounded-xl">
            <Users className="w-5 h-5" />
          </div>
          <div className="space-y-0.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Connected Users</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-black text-zinc-100">{totalUsersCount}</span>
              <span className="text-xs text-zinc-500">({guestUsersCount} sandbox guests)</span>
            </div>
          </div>
        </div>

        {/* Metric Card: Action logs */}
        <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-5 flex items-center gap-4 shadow-md">
          <div className="p-3 bg-amber-500/10 text-amber-400 border border-amber-500/15 rounded-xl">
            <Activity className="w-5 h-5" />
          </div>
          <div className="space-y-0.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">System Telemetry</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-black text-zinc-100">{logs.length}</span>
              <span className="text-xs text-zinc-500">logs recorded</span>
            </div>
          </div>
        </div>

        {/* Metric Card: Realtime sync status */}
        <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-5 flex items-center gap-4 shadow-md">
          <div className="p-3 bg-red-500/10 text-red-400 border border-red-500/15 rounded-xl">
            <Clock className="w-5 h-5" />
          </div>
          <div className="space-y-0.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Live Status Sync</span>
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 bg-emerald-500 rounded-full animate-pulse" />
              <span className="text-xs font-mono font-bold text-emerald-400 uppercase tracking-wider">Live Monitoring</span>
            </div>
          </div>
        </div>

      </div>

      {/* Tabs Menu */}
      <div className="flex flex-wrap gap-2 border-b border-zinc-900 pb-px">
        <button
          onClick={() => setActiveTab('sessions')}
          className={`flex items-center gap-2 px-5 py-3 border-b-2 text-sm font-bold transition-all ${
            activeTab === 'sessions'
              ? 'border-red-500 text-red-400 bg-red-500/5'
              : 'border-transparent text-zinc-500 hover:text-zinc-300 hover:bg-zinc-950/40'
          }`}
        >
          <Smartphone className="w-4 h-4" />
          Linked Devices ({sessions.length})
        </button>
        <button
          onClick={() => setActiveTab('users')}
          className={`flex items-center gap-2 px-5 py-3 border-b-2 text-sm font-bold transition-all ${
            activeTab === 'users'
              ? 'border-red-500 text-red-400 bg-red-500/5'
              : 'border-transparent text-zinc-500 hover:text-zinc-300 hover:bg-zinc-950/40'
          }`}
        >
          <Users className="w-4 h-4" />
          User Accounts ({users.length})
        </button>
        <button
          onClick={() => setActiveTab('logs')}
          className={`flex items-center gap-2 px-5 py-3 border-b-2 text-sm font-bold transition-all ${
            activeTab === 'logs'
              ? 'border-red-500 text-red-400 bg-red-500/5'
              : 'border-transparent text-zinc-500 hover:text-zinc-300 hover:bg-zinc-950/40'
          }`}
        >
          <FileText className="w-4 h-4" />
          Connection Logs ({logs.length})
        </button>
        <button
          onClick={() => setActiveTab('backup')}
          className={`flex items-center gap-2 px-5 py-3 border-b-2 text-sm font-bold transition-all ${
            activeTab === 'backup'
              ? 'border-red-500 text-red-400 bg-red-500/5'
              : 'border-transparent text-zinc-500 hover:text-zinc-300 hover:bg-zinc-950/40'
          }`}
        >
          <Database className="w-4 h-4" />
          Backups & Data
        </button>
      </div>

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

      {/* Tab Panels */}
      <div className="bg-zinc-950 border border-zinc-900 rounded-2xl overflow-hidden min-h-[400px]">
        
        {/* Tab 1: Active Sessions */}
        {activeTab === 'sessions' && (
          <div className="divide-y divide-zinc-900">
            {/* Header with Search and Status Filter */}
            <div className="p-5 bg-zinc-900/30 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="space-y-1">
                <h3 className="text-base font-bold text-zinc-200">System WhatsApp Sessions</h3>
                <p className="text-xs text-zinc-500">Search and manage credentials for both guests and logged-in user accounts.</p>
              </div>

              {/* Filters layout */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                  <input
                    type="text"
                    placeholder="Search email, phone..."
                    value={sessionSearch}
                    onChange={(e) => setSessionSearch(e.target.value)}
                    className="w-full sm:w-60 pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-xl focus:outline-none focus:border-red-500 text-zinc-200 placeholder-zinc-550 text-xs transition-colors"
                  />
                </div>

                <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-xl">
                  <Filter className="w-3.5 h-3.5 text-zinc-500" />
                  <select
                    value={sessionFilter}
                    onChange={(e: any) => setSessionFilter(e.target.value)}
                    className="bg-transparent text-xs text-zinc-300 font-semibold focus:outline-none cursor-pointer"
                  >
                    <option value="all">All Statuses</option>
                    <option value="connected">Connected</option>
                    <option value="connecting">Connecting</option>
                    <option value="disconnected">Disconnected</option>
                  </select>
                </div>
              </div>
            </div>

            {filteredSessions.length === 0 ? (
              <div className="p-12 text-center text-zinc-500 space-y-2">
                <Smartphone className="w-10 h-10 mx-auto text-zinc-700" />
                <p className="text-sm">No WhatsApp sessions found matching current filter guidelines.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm text-zinc-400">
                  <thead className="bg-zinc-900/50 text-zinc-500 uppercase tracking-wider text-[10px] font-bold">
                    <tr>
                      <th className="p-4">Owner Account</th>
                      <th className="p-4">WhatsApp Phone</th>
                      <th className="p-4">Connection State</th>
                      <th className="p-4">Device Config</th>
                      <th className="p-4">Paired Timestamp</th>
                      <th className="p-4">Session ID</th>
                      <th className="p-4 text-right">Administrative Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-900">
                    {filteredSessions.map((sess) => (
                      <tr key={sess.userId} className="hover:bg-zinc-900/20 transition-colors">
                        <td className="p-4">
                          <div className="flex items-center gap-2.5">
                            <span className={`w-2 h-2 rounded-full ${sess.email.includes('guest_') ? 'bg-zinc-600' : 'bg-red-500'}`} />
                            <div>
                              <span className="font-semibold text-zinc-200 block">{sess.email}</span>
                              <span className="text-[10px] text-zinc-500 block">
                                {sess.email.includes('guest_') ? 'Sandbox Guest Account' : 'Registered Member Account'}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td className="p-4 font-mono text-xs font-bold text-zinc-300">
                          {sess.phone ? `+${sess.phone}` : <span className="text-zinc-650 font-normal">Not paired</span>}
                        </td>
                        <td className="p-4">
                          <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 text-[10px] font-extrabold font-mono uppercase rounded-full ${
                            sess.status === 'connected' 
                              ? 'bg-emerald-500/10 text-emerald-400' 
                              : sess.status === 'connecting'
                              ? 'bg-amber-500/10 text-amber-400'
                              : 'bg-zinc-800 text-zinc-500'
                          }`}>
                            <span className={`w-1 h-1 rounded-full ${sess.status === 'connected' ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-500'}`} />
                            {sess.status}
                          </span>
                        </td>
                        <td className="p-4 text-xs text-zinc-500 font-sans">
                          {sess.status === 'connected' ? 'Mac OS (Chrome)' : <span className="text-zinc-700">—</span>}
                        </td>
                        <td className="p-4 font-mono text-xs text-zinc-500">
                          {sess.pairedAt ? new Date(sess.pairedAt).toLocaleString() : 'N/A'}
                        </td>
                        <td className="p-4 font-mono text-xs text-zinc-550 truncate max-w-[120px]" title={sess.userId}>
                          {sess.userId}
                        </td>
                        <td className="p-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* Download individual creds.json */}
                            {sess.status === 'connected' && (
                              <a
                                href={`/api/admin/download-creds/${sess.userId}?token=${authToken}`}
                                target="_blank"
                                rel="noreferrer"
                                className="p-1.5 bg-zinc-900 hover:bg-emerald-500/10 text-zinc-500 hover:text-emerald-400 border border-zinc-850 hover:border-emerald-500/20 rounded-lg transition-all"
                                title="Download credentials creds.json"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </a>
                            )}
                            {/* Disconnect WhatsApp Session */}
                            <button
                              onClick={() => handleDisconnectSession(sess.userId, sess.email)}
                              className="p-1.5 bg-zinc-900 hover:bg-red-500/10 text-zinc-500 hover:text-red-400 border border-zinc-850 hover:border-red-500/20 rounded-lg transition-all"
                              title="Force Disconnect WhatsApp Web Socket"
                            >
                              <Power className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Users Directory */}
        {activeTab === 'users' && (
          <div className="divide-y divide-zinc-900">
            <div className="p-5 bg-zinc-900/30 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="space-y-1">
                <h3 className="text-base font-bold text-zinc-200">Registered Accounts Directory</h3>
                <p className="text-xs text-zinc-500">Manage authorization privileges, role assignments, and check profiles registration dates.</p>
              </div>

              {/* User search bar */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Search user accounts..."
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  className="w-full sm:w-60 pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-xl focus:outline-none focus:border-red-500 text-zinc-200 placeholder-zinc-550 text-xs transition-colors"
                />
              </div>
            </div>

            {filteredUsers.length === 0 ? (
              <div className="p-12 text-center text-zinc-500 space-y-2">
                <Users className="w-10 h-10 mx-auto text-zinc-700" />
                <p className="text-sm">No registered user profiles found matching filters.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm text-zinc-400">
                  <thead className="bg-zinc-900/50 text-zinc-500 uppercase tracking-wider text-[10px] font-bold">
                    <tr>
                      <th className="p-4">User Identity Details</th>
                      <th className="p-4">Assigned Role</th>
                      <th className="p-4">Created Date</th>
                      <th className="p-4">Secure Identifier</th>
                      <th className="p-4 text-right">Role Management</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-900">
                    {filteredUsers.map((u) => (
                      <tr key={u.id} className="hover:bg-zinc-900/20 transition-colors">
                        <td className="p-4">
                          <div className="flex items-center gap-3">
                            <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-xs font-black uppercase shrink-0 ${
                              u.role === 'admin' ? 'bg-red-500/10 text-red-400 border border-red-500/15' : 'bg-zinc-800 text-zinc-300'
                            }`}>
                              {u.name.charAt(0)}
                            </div>
                            <div>
                              <span className="font-semibold text-zinc-200 block">{u.name}</span>
                              <span className="text-xs text-zinc-500 block font-mono">{u.email}</span>
                            </div>
                          </div>
                        </td>
                        <td className="p-4">
                          <span className={`px-2 py-0.5 text-[10px] font-extrabold uppercase rounded border ${
                            u.role === 'admin' 
                              ? 'bg-red-500/10 text-red-400 border-red-500/25' 
                              : 'bg-zinc-900 text-zinc-450 border-zinc-800'
                          }`}>
                            {u.role}
                          </span>
                        </td>
                        <td className="p-4 font-mono text-xs text-zinc-500">
                          {u.createdAt ? new Date(u.createdAt).toLocaleString() : 'N/A'}
                        </td>
                        <td className="p-4 font-mono text-xs text-zinc-500">{u.id}</td>
                        <td className="p-4 text-right">
                          <button
                            onClick={() => handleToggleRole(u.id, u.email)}
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border transition-all ${
                              u.role === 'admin'
                                ? 'bg-zinc-900 hover:bg-zinc-850 border-zinc-850 hover:border-zinc-800 text-zinc-400'
                                : 'bg-red-500/5 hover:bg-red-500/10 border-red-500/10 hover:border-red-500/20 text-red-400'
                            }`}
                          >
                            {u.role === 'admin' ? 'Demote to User' : 'Promote to Admin'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Tab 3: System Logs */}
        {activeTab === 'logs' && (
          <div className="flex flex-col h-[520px]">
            {/* Header with search for telemetry logs */}
            <div className="p-5 bg-zinc-900/30 flex flex-col md:flex-row md:items-center justify-between gap-4 shrink-0">
              <div className="space-y-1">
                <h3 className="text-base font-bold text-zinc-200">System Activity & Connection Telemetry Logs</h3>
                <p className="text-xs text-zinc-500">Live feed monitoring of pairings, failures, unlinking, and bot actions.</p>
              </div>

              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Filter logs by term..."
                  value={logSearch}
                  onChange={(e) => setLogSearch(e.target.value)}
                  className="w-full sm:w-60 pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-xl focus:outline-none focus:border-red-500 text-zinc-200 placeholder-zinc-550 text-xs transition-colors"
                />
              </div>
            </div>

            {/* Scrollable code interface */}
            <div className="flex-1 p-4 overflow-y-auto bg-black/50 font-mono text-xs text-zinc-400 space-y-2 border-t border-zinc-900">
              {filteredLogs.length === 0 ? (
                <div className="h-full flex items-center justify-center text-zinc-650">
                  <span>No matching telemetry lines found in current log buffer.</span>
                </div>
              ) : (
                filteredLogs.map((log) => {
                  const isErr = log.action.includes('error') || log.action.includes('fail') || log.message.toLowerCase().includes('fail') || log.message.toLowerCase().includes('error');
                  const isConn = log.action.includes('connect');
                  const isPairing = log.action.includes('pairing') || log.action.includes('pair');
                  
                  return (
                    <div key={log.id} className="hover:bg-zinc-900/45 p-2 rounded transition-colors flex items-start gap-4">
                      <span className="text-zinc-650 shrink-0 select-none">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                      <span className={`px-1.5 py-0.5 font-bold text-[9px] rounded uppercase shrink-0 tracking-wider font-sans ${
                        isErr
                          ? 'bg-red-500/15 text-red-400 border border-red-500/10'
                          : isConn
                          ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/10'
                          : isPairing
                          ? 'bg-amber-500/15 text-amber-400 border border-amber-500/10'
                          : 'bg-zinc-850 text-zinc-450 border border-zinc-800'
                      }`}>
                        {log.action}
                      </span>
                      <span className="text-zinc-500 font-bold shrink-0">{log.email}:</span>
                      <span className="text-zinc-300 break-all">{log.message}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* Tab 4: Database & Backups */}
        {activeTab === 'backup' && (
          <div className="p-8 space-y-6 max-w-2xl">
            <div className="space-y-2">
              <h3 className="text-lg font-bold text-zinc-100 flex items-center gap-2">
                <Database className="w-5 h-5 text-red-400" />
                Administrative Backups & State Store Recovery
              </h3>
              <p className="text-sm text-zinc-400 leading-relaxed">
                Download the entire current memory snapshot payload. This produces a raw JSON backup containing registered profiles, credentials sessions metadata, and telemetry logs.
              </p>
            </div>

            <div className="p-5 bg-zinc-900/40 border border-zinc-900 rounded-xl space-y-5">
              <div className="flex items-start gap-3.5">
                <HardDrive className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <h4 className="text-sm font-bold text-zinc-200">Local JSON Storage Adapter</h4>
                  <p className="text-xs text-zinc-500 leading-relaxed">
                    All persistent parameters are safely routed through our server-authoritative JSON file persistence models. No SQL databases or remote caches are exposed.
                  </p>
                </div>
              </div>

              <div className="pt-2">
                <a
                  href={`/api/admin/backup?token=${authToken}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 px-5 py-3 bg-red-500 hover:bg-red-400 text-zinc-950 font-extrabold text-xs rounded-xl transition-all shadow-md hover:shadow-lg active:scale-95"
                >
                  <Download className="w-4 h-4" />
                  Download Complete System Backup
                </a>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
