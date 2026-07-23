import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, doc, getDocs, setDoc, query, orderBy, limit, getDoc, disableNetwork, setLogLevel } from 'firebase/firestore';

const DATA_DIR = path.join(process.cwd(), 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.json');

export interface AdminNotification {
  id: string;
  type: 'user_register' | 'session_disconnect' | 'session_connect' | 'account_status' | 'system';
  title: string;
  message: string;
  userEmail?: string;
  userId?: string;
  timestamp: string;
  read: boolean;
}

export interface User {
  id: string;
  email: string;
  passwordHash?: string;
  name: string;
  role: 'admin' | 'user';
  googleId?: string;
  avatarUrl?: string;
  createdAt: string;
  status?: 'active' | 'suspended' | 'blocked';
  lastLogin?: string;
  lastActive?: string;
}

export interface CommandLogRecord {
  command: string;
  category: string;
  timestamp: string;
  chatJid?: string;
  chatName?: string;
}

export interface UserProfile {
  userId: string;
  email: string;
  name: string;
  whatsappName?: string;
  whatsappPhone?: string;
  avatarUrl?: string;
  registrationDate: string;
  lastLogin?: string;
  lastActive?: string;
  status: 'active' | 'suspended' | 'blocked';
  
  // Usage Statistics
  totalCommands: number;
  lastUsedCommand?: string;
  lastCommandTime?: string;
  mostUsedCommand?: string;
  commandCounts: Record<string, number>;
  recentCommands: CommandLogRecord[];
  
  totalAiRequests: number;
  totalDownloads: number;
  totalImagesGenerated: number;
  totalAudioDownloads: number;
  totalVideoDownloads: number;
  groupsJoined: number;
}

export interface Session {
  userId: string;
  email: string;
  phone?: string;
  status: 'connected' | 'disconnected' | 'connecting';
  pairedAt?: string;
  sessionToken?: string;
  mode?: 'public' | 'private';
  antidelete?: boolean;
}

export interface Log {
  id: string;
  userId: string;
  email: string;
  action: string;
  message: string;
  timestamp: string;
}

// Default admin setup
const DEFAULT_ADMIN: User = {
  id: 'usr_admin',
  email: 'kashafhijjaze@gmail.com',
  passwordHash: bcrypt.hashSync('Kashaf6573', 10),
  name: 'Kashaf Hijjaze',
  role: 'admin',
  createdAt: new Date().toISOString()
};

// Global in-memory cache
let cachedUsers: User[] = [];
let cachedSessions: Session[] = [];
let cachedLogs: Log[] = [];
let cachedNotifications: AdminNotification[] = [];
const cachedProfiles = new Map<string, UserProfile>();

try { setLogLevel('silent'); } catch (e) {}

const QUOTA_STATUS_FILE = path.join(DATA_DIR, 'firestore_quota_status.json');
let isFirestoreWriteDisabled = false;

try {
  if (fs.existsSync(QUOTA_STATUS_FILE)) {
    const statusData = JSON.parse(fs.readFileSync(QUOTA_STATUS_FILE, 'utf-8'));
    if (statusData.exhausted && statusData.timestamp) {
      const timeSinceDetection = Date.now() - statusData.timestamp;
      if (timeSinceDetection > 0 && timeSinceDetection < 24 * 60 * 60 * 1000) {
        isFirestoreWriteDisabled = true;
        console.warn('[Firestore] ⚠️ Firestore writes are suspended on boot due to cached write quota exhaustion. Operating in localized persistence mode.');
      } else if (timeSinceDetection >= 24 * 60 * 60 * 1000) {
        try {
          fs.unlinkSync(QUOTA_STATUS_FILE);
        } catch (uErr) {}
      }
    }
  }
} catch (err) {
  // Ignore
}

export function isFirestoreQuotaExhausted(): boolean {
  return isFirestoreWriteDisabled;
}

export function handleFirestoreError(err: any, context: string) {
  const errMsg = err?.message || String(err);
  const errCode = String(err?.code || '').toLowerCase();
  if (errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('Quota exceeded') || errCode.includes('resource-exhausted') || errCode.includes('quota')) {
    if (!isFirestoreWriteDisabled) {
      isFirestoreWriteDisabled = true;
      try { setLogLevel('silent'); } catch (e) {}
      console.warn(`[Firestore] ⚠️ Write quota exceeded (${context}). Firestore writes have been suspended. Operating in localized persistence mode.`);
      try {
        fs.writeFileSync(QUOTA_STATUS_FILE, JSON.stringify({
          exhausted: true,
          timestamp: Date.now(),
          context
        }, null, 2));
      } catch (fErr) {}
      
      if (firestoreDb) {
        console.log('[Firestore] Disabling Firebase SDK network connection and releasing client reference to prevent further write RPC errors...');
        disableNetwork(firestoreDb).catch(() => {});
        firestoreDb = null;
      }
    }
  } else {
    console.error(`[Firestore] Error in ${context}:`, err);
  }
}

// Track serialized states to prevent redundant / full-list Firestore writes
const lastPersistedUsers = new Map<string, string>();
const lastPersistedSessions = new Map<string, string>();

function syncLastPersisted() {
  lastPersistedUsers.clear();
  cachedUsers.forEach(u => lastPersistedUsers.set(u.id, JSON.stringify(u)));
  
  lastPersistedSessions.clear();
  cachedSessions.forEach(s => lastPersistedSessions.set(s.userId, JSON.stringify(s)));
}

// Initialize Firebase client SDK safely for server use
const CONFIG_FILE = path.join(process.cwd(), 'firebase-applet-config.json');
let firestoreDb: any = null;

try {
  if (isFirestoreWriteDisabled) {
    console.warn('[Firestore] ⚠️ Bypassing Firebase client SDK initialization on boot since write quota is marked as exhausted. Running in offline/localized file persistence mode.');
  } else if (fs.existsSync(CONFIG_FILE)) {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    if (config.projectId) {
      const app = initializeApp(config);
      firestoreDb = getFirestore(app, config.firestoreDatabaseId);
      console.log('Firebase client SDK initialized successfully on server with project:', config.projectId, 'and database:', config.firestoreDatabaseId || '(default)');
    }
  }
} catch (err) {
  console.error('Failed to initialize Firebase client SDK on server, falling back to local files:', err);
}

// Safely sanitize objects to remove any 'undefined' properties before writing to Firestore
function cleanUndefined<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

// Synchronous loading of local files (as fallback / initial setup)
function loadLocalData() {
  // Load users
  try {
    if (!fs.existsSync(USERS_FILE)) {
      cachedUsers = [DEFAULT_ADMIN];
      fs.writeFileSync(USERS_FILE, JSON.stringify(cachedUsers, null, 2));
    } else {
      const data = fs.readFileSync(USERS_FILE, 'utf-8');
      cachedUsers = JSON.parse(data || '[]');
    }
  } catch (err) {
    cachedUsers = [DEFAULT_ADMIN];
  }

  // Ensure default admin exists
  const adminIndex = cachedUsers.findIndex(u => u.email.toLowerCase() === 'kashafhijjaze@gmail.com');
  if (adminIndex === -1) {
    cachedUsers.push(DEFAULT_ADMIN);
    try { fs.writeFileSync(USERS_FILE, JSON.stringify(cachedUsers, null, 2)); } catch (e) {}
  } else {
    if (cachedUsers[adminIndex].role !== 'admin') {
      cachedUsers[adminIndex].role = 'admin';
      try { fs.writeFileSync(USERS_FILE, JSON.stringify(cachedUsers, null, 2)); } catch (e) {}
    }
  }

  // Load sessions
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      cachedSessions = JSON.parse(data || '[]');
    } else {
      cachedSessions = [];
    }
  } catch (err) {
    cachedSessions = [];
  }

  // Load logs
  try {
    if (fs.existsSync(LOGS_FILE)) {
      const data = fs.readFileSync(LOGS_FILE, 'utf-8');
      cachedLogs = JSON.parse(data || '[]');
    } else {
      cachedLogs = [];
    }
  } catch (err) {
    cachedLogs = [];
  }

  // Load profiles
  try {
    if (fs.existsSync(PROFILES_FILE)) {
      const data = fs.readFileSync(PROFILES_FILE, 'utf-8');
      const list: UserProfile[] = JSON.parse(data || '[]');
      cachedProfiles.clear();
      list.forEach(p => cachedProfiles.set(p.userId, p));
    }
  } catch (err) {
    // ignore
  }

  // Load notifications
  try {
    if (fs.existsSync(NOTIFICATIONS_FILE)) {
      const data = fs.readFileSync(NOTIFICATIONS_FILE, 'utf-8');
      cachedNotifications = JSON.parse(data || '[]');
    } else {
      cachedNotifications = [];
    }
  } catch (err) {
    cachedNotifications = [];
  }

  syncLastPersisted();
}

// Initial sync
loadLocalData();

// Async loader to sync from Firestore on boot
export async function loadFromFirestore(): Promise<void> {
  if (!firestoreDb || isFirestoreWriteDisabled) {
    console.log('Firestore is not active or has been disabled, using local file databases.');
    return;
  }
  try {
    console.log('Syncing data from Cloud Firestore database...');
    
    // Load Users
    const usersSnapshot = await getDocs(collection(firestoreDb, 'users'));
    if (!usersSnapshot.empty) {
      const users: User[] = [];
      usersSnapshot.forEach((doc: any) => {
        users.push(doc.data() as User);
      });
      cachedUsers = users;
      console.log(`Loaded ${users.length} users from Firestore.`);
    } else {
      // Seed firestore with local users
      console.log('Firestore users collection is empty. Seeding Firestore with default users.');
      for (const user of cachedUsers) {
        if (!isFirestoreWriteDisabled) {
          await setDoc(doc(firestoreDb, 'users', user.id), cleanUndefined(user));
        }
      }
    }

    // Load Sessions
    const sessionsSnapshot = await getDocs(collection(firestoreDb, 'sessions'));
    if (!sessionsSnapshot.empty) {
      const sessions: Session[] = [];
      sessionsSnapshot.forEach((doc: any) => {
        sessions.push(doc.data() as Session);
      });
      cachedSessions = sessions;
      console.log(`Loaded ${sessions.length} sessions from Firestore.`);
    } else {
      // Seed firestore with local sessions if any
      if (cachedSessions.length > 0) {
        for (const session of cachedSessions) {
          if (!isFirestoreWriteDisabled) {
            await setDoc(doc(firestoreDb, 'sessions', session.userId), cleanUndefined(session));
          }
        }
      }
    }

    // Load Logs from bundled document
    try {
      const logDocRef = doc(firestoreDb, 'system_logs', 'all');
      const logDocSnap = await getDoc(logDocRef);
      if (logDocSnap.exists()) {
        const data = logDocSnap.data();
        if (data && Array.isArray(data.logs)) {
          cachedLogs = data.logs;
          console.log(`Loaded ${cachedLogs.length} logs from bundled Firestore document.`);
        }
      } else {
        // Fallback: see if there are old individual logs
        console.log('Bundled logs not found. Falling back to individual legacy Firestore logs...');
        const logsSnapshot = await getDocs(query(collection(firestoreDb, 'logs'), orderBy('timestamp', 'desc'), limit(100)));
        if (!logsSnapshot.empty) {
          const logs: Log[] = [];
          logsSnapshot.forEach((doc: any) => {
            logs.push(doc.data() as Log);
          });
          cachedLogs = logs;
          console.log(`Loaded ${logs.length} logs from legacy Firestore logs.`);
        }
      }
    } catch (logErr) {
      handleFirestoreError(logErr, 'loadFromFirestore (logs)');
    }

    // Load Profiles
    try {
      const profilesSnapshot = await getDocs(collection(firestoreDb, 'profiles'));
      if (!profilesSnapshot.empty) {
        profilesSnapshot.forEach((docSnap: any) => {
          const profile = docSnap.data() as UserProfile;
          if (profile && profile.userId) {
            cachedProfiles.set(profile.userId, profile);
          }
        });
        console.log(`Loaded ${profilesSnapshot.size} user profiles from Firestore.`);
      }
    } catch (profErr) {
      handleFirestoreError(profErr, 'loadFromFirestore (profiles)');
    }
    syncLastPersisted();
  } catch (err) {
    handleFirestoreError(err, 'loadFromFirestore');
  }
}

export function getUsers(): User[] {
  return cachedUsers;
}

export function saveUsers(users: User[]): void {
  // Find which users actually changed
  const changedUsers = users.filter(user => {
    const serialized = JSON.stringify(user);
    const lastSerialized = lastPersistedUsers.get(user.id);
    return serialized !== lastSerialized;
  });

  cachedUsers = users;
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error('Error saving users file locally:', err);
  }

  // Update the persistence cache
  changedUsers.forEach(user => {
    lastPersistedUsers.set(user.id, JSON.stringify(user));
  });

  if (firestoreDb && !isFirestoreWriteDisabled && changedUsers.length > 0) {
    // Only save changed users to Firestore in the background
    Promise.all(
      changedUsers.map(user => setDoc(doc(firestoreDb, 'users', user.id), cleanUndefined(user)))
    ).catch(err => {
      handleFirestoreError(err, 'saveUsers');
    });
  }
}

export function getSessions(): Session[] {
  return cachedSessions;
}

export function saveSessions(sessions: Session[]): void {
  // Find which sessions actually changed
  const changedSessions = sessions.filter(sess => {
    const serialized = JSON.stringify(sess);
    const lastSerialized = lastPersistedSessions.get(sess.userId);
    return serialized !== lastSerialized;
  });

  cachedSessions = sessions;
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (err) {
    console.error('Error saving sessions file locally:', err);
  }

  // Update the persistence cache
  changedSessions.forEach(sess => {
    lastPersistedSessions.set(sess.userId, JSON.stringify(sess));
  });

  if (firestoreDb && !isFirestoreWriteDisabled && changedSessions.length > 0) {
    // Only save changed sessions to Firestore in the background
    Promise.all(
      changedSessions.map(session => setDoc(doc(firestoreDb, 'sessions', session.userId), cleanUndefined(session)))
    ).catch(err => {
      handleFirestoreError(err, 'saveSessions');
    });
  }
}

export function getLogs(): Log[] {
  return cachedLogs;
}

let logsSyncTimeout: NodeJS.Timeout | null = null;

function triggerLogsSyncToFirestore() {
  if (logsSyncTimeout || isFirestoreWriteDisabled) return; // Already scheduled or disabled
  
  logsSyncTimeout = setTimeout(async () => {
    logsSyncTimeout = null;
    if (firestoreDb && !isFirestoreWriteDisabled) {
      try {
        // Keep only top 200 logs in Firestore to keep the document size small
        const logsToSave = cachedLogs.slice(0, 200);
        await setDoc(doc(firestoreDb, 'system_logs', 'all'), {
          logs: logsToSave,
          updatedAt: new Date().toISOString()
        });
        console.log(`[LogSync] Successfully synced ${logsToSave.length} logs to bundled Firestore.`);
      } catch (err) {
        handleFirestoreError(err, 'syncLogs');
      }
    }
  }, 10000); // Debounce for 10 seconds
}

export function addLog(userId: string, email: string, action: string, message: string): void {
  try {
    const newLog: Log = {
      id: 'log_' + Math.random().toString(36).substr(2, 9),
      userId,
      email,
      action,
      message,
      timestamp: new Date().toISOString()
    };
    cachedLogs.unshift(newLog);
    // Limit to 1000 logs
    if (cachedLogs.length > 1000) {
      cachedLogs.splice(1000);
    }
    
    try {
      fs.writeFileSync(LOGS_FILE, JSON.stringify(cachedLogs, null, 2));
    } catch (err) {}

    if (firestoreDb) {
      triggerLogsSyncToFirestore();
    }
  } catch (err) {
    console.error('Error adding log:', err);
  }
}

export function getBotMode(userId: string): 'public' | 'private' {
  const session = cachedSessions.find(s => s.userId === userId);
  return (session && session.mode) || 'public';
}

export function setBotMode(userId: string, mode: 'public' | 'private'): void {
  const sessionIndex = cachedSessions.findIndex(s => s.userId === userId);
  if (sessionIndex !== -1) {
    cachedSessions[sessionIndex].mode = mode;
    saveSessions(cachedSessions);
  } else {
    // If session doesn't exist yet, we can pre-create it or save it
    const newSess: Session = {
      userId,
      email: 'guest', // Default/fallback
      status: 'disconnected',
      mode
    };
    cachedSessions.push(newSess);
    saveSessions(cachedSessions);
  }
}

export function getAntiDelete(userId: string): boolean {
  const session = cachedSessions.find(s => s.userId === userId);
  // Default to true (enabled) if not specified
  return session && session.antidelete !== undefined ? session.antidelete : true;
}

export function setAntiDelete(userId: string, enabled: boolean): void {
  const sessionIndex = cachedSessions.findIndex(s => s.userId === userId);
  if (sessionIndex !== -1) {
    cachedSessions[sessionIndex].antidelete = enabled;
    saveSessions(cachedSessions);
  } else {
    const newSess: Session = {
      userId,
      email: 'guest',
      status: 'disconnected',
      antidelete: enabled
    };
    cachedSessions.push(newSess);
    saveSessions(cachedSessions);
  }
}

export function getFirestoreDb(): any {
  if (isFirestoreWriteDisabled) return null;
  return firestoreDb;
}

export interface ChannelConfig {
  name: string;
  link: string;
  newsletterJid: string;
}

const CHANNEL_CONFIG_FILE = path.join(DATA_DIR, 'channel_config.json');

const DEFAULT_CHANNEL_CONFIG: ChannelConfig = {
  name: 'HIJJAZE BOT OFFICIAL CHANNEL',
  link: 'https://whatsapp.com/channel/0029Vb7wo6O5a23w6LJo2K1y',
  newsletterJid: '120363426834632590@newsletter'
};

let cachedChannelConfig: ChannelConfig = DEFAULT_CHANNEL_CONFIG;

try {
  if (fs.existsSync(CHANNEL_CONFIG_FILE)) {
    const data = JSON.parse(fs.readFileSync(CHANNEL_CONFIG_FILE, 'utf-8'));
    cachedChannelConfig = { ...DEFAULT_CHANNEL_CONFIG, ...data };
  }
} catch (e) {
  cachedChannelConfig = DEFAULT_CHANNEL_CONFIG;
}

export function getChannelConfig(): ChannelConfig {
  return cachedChannelConfig;
}

export function setChannelConfig(config: Partial<ChannelConfig>): ChannelConfig {
  cachedChannelConfig = { ...cachedChannelConfig, ...config };
  try {
    fs.writeFileSync(CHANNEL_CONFIG_FILE, JSON.stringify(cachedChannelConfig, null, 2));
  } catch (e) {
    console.error('Error saving channel config:', e);
  }
  return cachedChannelConfig;
}

// ==========================================
// GROUP MODERATION PERSISTENCE (Warnings, Mutes, Bans)
// ==========================================

export interface WarningRecord {
  id: string;
  chatJid: string;
  userJid: string;
  reason: string;
  issuedBy: string;
  timestamp: string;
}

export interface MuteRecord {
  chatJid: string;
  userJid: string;
  mutedBy: string;
  reason: string;
  mutedAt: string;
  expiresAt: number | null; // epoch ms timestamp or null for permanent
}

export interface BanRecord {
  chatJid: string;
  userJid: string;
  bannedBy: string;
  reason: string;
  bannedAt: string;
}

export interface ModerationData {
  warnings: WarningRecord[];
  mutes: MuteRecord[];
  bans: BanRecord[];
}

const MODERATION_FILE = path.join(DATA_DIR, 'moderation.json');

let cachedModeration: ModerationData = {
  warnings: [],
  mutes: [],
  bans: []
};

try {
  if (fs.existsSync(MODERATION_FILE)) {
    const raw = fs.readFileSync(MODERATION_FILE, 'utf-8');
    cachedModeration = JSON.parse(raw);
    if (!cachedModeration.warnings) cachedModeration.warnings = [];
    if (!cachedModeration.mutes) cachedModeration.mutes = [];
    if (!cachedModeration.bans) cachedModeration.bans = [];
  }
} catch (e) {
  cachedModeration = { warnings: [], mutes: [], bans: [] };
}

function saveModeration() {
  try {
    fs.writeFileSync(MODERATION_FILE, JSON.stringify(cachedModeration, null, 2));
  } catch (e) {
    console.error('Error saving moderation data:', e);
  }
}

// --- WARNINGS ---
export function addWarning(chatJid: string, userJid: string, reason: string, issuedBy: string): WarningRecord[] {
  const newWarn: WarningRecord = {
    id: `warn_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    chatJid,
    userJid,
    reason,
    issuedBy,
    timestamp: new Date().toISOString()
  };
  cachedModeration.warnings.push(newWarn);
  saveModeration();
  return getWarnings(chatJid, userJid);
}

export function getWarnings(chatJid: string, userJid: string): WarningRecord[] {
  return cachedModeration.warnings.filter(w => w.chatJid === chatJid && w.userJid === userJid);
}

export function clearWarnings(chatJid: string, userJid: string): number {
  const initialCount = cachedModeration.warnings.length;
  cachedModeration.warnings = cachedModeration.warnings.filter(w => !(w.chatJid === chatJid && w.userJid === userJid));
  const removedCount = initialCount - cachedModeration.warnings.length;
  saveModeration();
  return removedCount;
}

// --- MUTES ---
export function muteUser(chatJid: string, userJid: string, mutedBy: string, reason: string, durationMs: number | null): MuteRecord {
  // Remove existing mute if any
  unmuteUser(chatJid, userJid);

  const mutedAt = new Date().toISOString();
  const expiresAt = durationMs ? Date.now() + durationMs : null;

  const newMute: MuteRecord = {
    chatJid,
    userJid,
    mutedBy,
    reason,
    mutedAt,
    expiresAt
  };

  cachedModeration.mutes.push(newMute);
  saveModeration();
  return newMute;
}

export function unmuteUser(chatJid: string, userJid: string): boolean {
  const initialLen = cachedModeration.mutes.length;
  cachedModeration.mutes = cachedModeration.mutes.filter(m => !(m.chatJid === chatJid && m.userJid === userJid));
  const removed = cachedModeration.mutes.length < initialLen;
  if (removed) saveModeration();
  return removed;
}

export function getMuteRecord(chatJid: string, userJid: string): MuteRecord | null {
  const record = cachedModeration.mutes.find(m => m.chatJid === chatJid && m.userJid === userJid);
  if (!record) return null;

  // Check if expired
  if (record.expiresAt && Date.now() > record.expiresAt) {
    unmuteUser(chatJid, userJid);
    return null;
  }
  return record;
}

export function isUserMuted(chatJid: string, userJid: string): boolean {
  return getMuteRecord(chatJid, userJid) !== null;
}

// --- BANS ---
export function banUser(chatJid: string, userJid: string, bannedBy: string, reason: string): BanRecord {
  unbanUser(chatJid, userJid);

  const newBan: BanRecord = {
    chatJid,
    userJid,
    bannedBy,
    reason,
    bannedAt: new Date().toISOString()
  };

  cachedModeration.bans.push(newBan);
  saveModeration();
  return newBan;
}

export function unbanUser(chatJid: string, userJid: string): boolean {
  const initialLen = cachedModeration.bans.length;
  cachedModeration.bans = cachedModeration.bans.filter(b => !(b.chatJid === chatJid && b.userJid === userJid));
  const removed = cachedModeration.bans.length < initialLen;
  if (removed) saveModeration();
  return removed;
}

export function getBanRecord(chatJid: string, userJid: string): BanRecord | null {
  return cachedModeration.bans.find(b => b.chatJid === chatJid && b.userJid === userJid) || null;
}

export function isUserBanned(chatJid: string, userJid: string): boolean {
  return getBanRecord(chatJid, userJid) !== null;
}

// ==========================================
// USER PROFILE & USAGE STATISTICS MANAGEMENT
// ==========================================

export function getUserProfile(userId: string, email?: string, name?: string): UserProfile {
  let profile = cachedProfiles.get(userId);
  if (!profile) {
    const matchedUser = cachedUsers.find(u => u.id === userId);
    profile = {
      userId,
      email: email || matchedUser?.email || 'guest@hijjaze.local',
      name: name || matchedUser?.name || 'WhatsApp User',
      registrationDate: matchedUser?.createdAt || new Date().toISOString(),
      lastLogin: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      status: matchedUser?.status || 'active',
      totalCommands: 0,
      commandCounts: {},
      recentCommands: [],
      totalAiRequests: 0,
      totalDownloads: 0,
      totalImagesGenerated: 0,
      totalAudioDownloads: 0,
      totalVideoDownloads: 0,
      groupsJoined: 0
    };
    cachedProfiles.set(userId, profile);
    saveProfiles();
  }
  return profile;
}

export function saveProfiles(): void {
  const profilesList = Array.from(cachedProfiles.values());
  try {
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(profilesList, null, 2));
  } catch (err) {
    console.error('Error saving profiles locally:', err);
  }

  if (firestoreDb && !isFirestoreWriteDisabled) {
    Promise.all(
      profilesList.map(p => setDoc(doc(firestoreDb, 'profiles', p.userId), cleanUndefined(p)))
    ).catch(err => {
      handleFirestoreError(err, 'saveProfiles');
    });
  }
}

export function updateUserProfileInfo(userId: string, info: { name?: string; whatsappName?: string; whatsappPhone?: string; avatarUrl?: string; lastLogin?: string; lastActive?: string }): UserProfile {
  const profile = getUserProfile(userId);
  if (info.name) profile.name = info.name;
  if (info.whatsappName) profile.whatsappName = info.whatsappName;
  if (info.whatsappPhone) profile.whatsappPhone = info.whatsappPhone;
  if (info.avatarUrl) profile.avatarUrl = info.avatarUrl;
  if (info.lastLogin) profile.lastLogin = info.lastLogin;
  if (info.lastActive) profile.lastActive = info.lastActive;

  saveProfiles();
  return profile;
}

export function getUserStatus(userId: string): 'active' | 'suspended' | 'blocked' {
  const profile = getUserProfile(userId);
  const user = cachedUsers.find(u => u.id === userId);
  return profile.status || user?.status || 'active';
}

export function setUserStatus(userId: string, status: 'active' | 'suspended' | 'blocked'): UserProfile {
  const profile = getUserProfile(userId);
  profile.status = status;
  const userIndex = cachedUsers.findIndex(u => u.id === userId);
  if (userIndex !== -1) {
    cachedUsers[userIndex].status = status;
    saveUsers(cachedUsers);
  }
  saveProfiles();
  return profile;
}

export function trackCommandUsage(
  userId: string, 
  email: string, 
  cmdName: string, 
  category: string, 
  chatJid?: string, 
  chatName?: string
): UserProfile {
  const profile = getUserProfile(userId, email);
  const now = new Date().toISOString();

  profile.totalCommands = (profile.totalCommands || 0) + 1;
  profile.lastUsedCommand = cmdName;
  profile.lastCommandTime = now;
  profile.lastActive = now;

  if (!profile.commandCounts) profile.commandCounts = {};
  profile.commandCounts[cmdName] = (profile.commandCounts[cmdName] || 0) + 1;

  // Compute most used command
  let maxCount = 0;
  let topCmd = cmdName;
  for (const [cmd, count] of Object.entries(profile.commandCounts)) {
    if (count > maxCount) {
      maxCount = count;
      topCmd = cmd;
    }
  }
  profile.mostUsedCommand = topCmd;

  // Add to recent commands (keep last 20)
  if (!profile.recentCommands) profile.recentCommands = [];
  profile.recentCommands.unshift({
    command: cmdName,
    category,
    timestamp: now,
    chatJid,
    chatName
  });
  if (profile.recentCommands.length > 20) {
    profile.recentCommands = profile.recentCommands.slice(0, 20);
  }

  // Category specific counters
  const cleanCat = category.toUpperCase();
  const lowerCmd = cmdName.toLowerCase();

  if (cleanCat.includes('AI')) {
    profile.totalAiRequests = (profile.totalAiRequests || 0) + 1;
  }

  if (cleanCat.includes('DOWNLOAD')) {
    profile.totalDownloads = (profile.totalDownloads || 0) + 1;
    if (lowerCmd.includes('play') || lowerCmd.includes('audio') || lowerCmd.includes('song') || lowerCmd.includes('mp3')) {
      profile.totalAudioDownloads = (profile.totalAudioDownloads || 0) + 1;
    }
    if (lowerCmd.includes('video') || lowerCmd.includes('mp4')) {
      profile.totalVideoDownloads = (profile.totalVideoDownloads || 0) + 1;
    }
  }

  if (cleanCat.includes('STICKER') || cleanCat.includes('IMAGE') || lowerCmd === 's' || lowerCmd === 'sticker' || lowerCmd === 'generate' || lowerCmd === 'img') {
    profile.totalImagesGenerated = (profile.totalImagesGenerated || 0) + 1;
  }

  if (chatJid && chatJid.endsWith('@g.us')) {
    if (!profile.groupsJoined) profile.groupsJoined = 1;
  }

  saveProfiles();
  return profile;
}

export function getAllUserProfiles(): UserProfile[] {
  // Ensure all registered users have a profile entry
  cachedUsers.forEach(u => {
    if (!cachedProfiles.has(u.id)) {
      getUserProfile(u.id, u.email, u.name);
    }
  });
  return Array.from(cachedProfiles.values());
}

export function deleteUserAccount(userId: string): void {
  cachedUsers = cachedUsers.filter(u => u.id !== userId);
  cachedSessions = cachedSessions.filter(s => s.userId !== userId);
  cachedProfiles.delete(userId);
  saveUsers(cachedUsers);
  saveSessions(cachedSessions);
  saveProfiles();
}

// Admin Notification Management
export function getAdminNotifications(): AdminNotification[] {
  return [...cachedNotifications].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export function saveNotifications(): void {
  try {
    fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(cachedNotifications, null, 2));
  } catch (err) {
    console.error('Failed to save notifications locally:', err);
  }
}

export function addAdminNotification(data: Omit<AdminNotification, 'id' | 'timestamp' | 'read'>): AdminNotification {
  const notif: AdminNotification = {
    id: 'notif_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    timestamp: new Date().toISOString(),
    read: false,
    ...data
  };
  cachedNotifications.unshift(notif);
  if (cachedNotifications.length > 100) {
    cachedNotifications = cachedNotifications.slice(0, 100);
  }
  saveNotifications();
  return notif;
}

export function markAdminNotificationRead(id: string): void {
  const notif = cachedNotifications.find(n => n.id === id);
  if (notif) {
    notif.read = true;
    saveNotifications();
  }
}

export function markAllAdminNotificationsRead(): void {
  cachedNotifications.forEach(n => n.read = true);
  saveNotifications();
}

export function deleteAdminNotification(id: string): void {
  cachedNotifications = cachedNotifications.filter(n => n.id !== id);
  saveNotifications();
}

export function clearAllAdminNotifications(): void {
  cachedNotifications = [];
  saveNotifications();
}




