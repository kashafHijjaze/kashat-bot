export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  avatarUrl?: string;
  googleId?: string;
  createdAt?: string;
  status?: 'active' | 'suspended' | 'blocked';
  lastLogin?: string;
  lastActive?: string;
}

export interface Session {
  userId: string;
  email: string;
  phone?: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'qr';
  pairedAt?: string;
  qr?: string;
}

export interface SystemLog {
  id: string;
  userId: string;
  email: string;
  action: string;
  message: string;
  timestamp: string;
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

export interface EnhancedUser extends User {
  profile: UserProfile;
  sessionStatus: 'connected' | 'disconnected' | 'connecting';
  whatsappPhone: string | null;
  accountStatus: 'active' | 'suspended' | 'blocked';
}

export interface AdminAnalytics {
  totalUsers: number;
  activeSessions: number;
  totalCommands: number;
  totalAiRequests: number;
  totalDownloads: number;
  totalImagesGenerated: number;
  totalAudioDownloads: number;
  totalVideoDownloads: number;
  mostActiveUser: string;
  mostUsedCommand: string;
  newUsersToday: number;
  globalCommandCounts: Record<string, number>;
}

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

