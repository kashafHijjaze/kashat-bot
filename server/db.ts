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

export interface User {
  id: string;
  email: string;
  passwordHash?: string;
  name: string;
  role: 'admin' | 'user';
  googleId?: string;
  avatarUrl?: string;
  createdAt: string;
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
  link: 'https://whatsapp.com/channel/0029Vb31A1fEquiT4S34jG1d',
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


