import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface AuthProfile { login: string | null; displayName: string | null; profileImageUrl: string | null; }
export interface AuthStatus { setupRequired: boolean; connected: boolean; ownerConfigured: boolean; profile: AuthProfile | null; scopes: string[]; }
export interface Settings { version: number; keepAwake: boolean; autoMaximiseStream: boolean; maximiseMode: string; browserPollSeconds: number; sessionDurationHours: number; source: string; }
export interface ScheduleResponse { version: number; channels: string[]; }
export interface FollowingChannel { id: string; login: string; name: string; }
export interface FollowingResponse { data: FollowingChannel[]; complete: boolean; }
export interface PriorityChannelStatus { login: string; isLive: boolean | null; }
export interface PriorityStatus { channels: PriorityChannelStatus[]; checkedAt: string | null; timeZone: string; }
export interface SiteEvent { id: number; occurredAt: string; type: string; summary: string; details: string | null; }
export interface SessionState { sessionId: string; revision: number; state: string; automationMode: string; channel: string | null; selectionTier: string | null; reason: string; statusFreshness: string; pollAfterSeconds: number; settingsVersion: number; expiresAt: string; }

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  authStatus(): Observable<AuthStatus> { return this.http.get<AuthStatus>('/api/auth/status'); }
  settings(): Observable<Settings> { return this.http.get<Settings>('/api/settings'); }
  saveSettings(settings: Settings): Observable<Settings> { return this.http.put<Settings>('/api/settings', settings, { headers: new HttpHeaders({ 'If-Match': String(settings.version) }) }); }
  schedule(): Observable<ScheduleResponse> { return this.http.get<ScheduleResponse>('/api/schedule'); }
  saveSchedule(schedule: ScheduleResponse): Observable<ScheduleResponse> { return this.http.put<ScheduleResponse>('/api/schedule', schedule); }
  following(): Observable<FollowingResponse> { return this.http.get<FollowingResponse>('/api/channels/following'); }
  priorityStatus(): Observable<PriorityStatus> { return this.http.get<PriorityStatus>('/api/channels/priority-status'); }
  recentEvents(): Observable<SiteEvent[]> { return this.http.get<SiteEvent[]>('/api/logs'); }
  clientHeartbeat(clientId: string): Observable<void> { return this.http.post<void>('/api/logs/presence', { clientId }); }
  playbackStarted(sessionId: string, channel: string): Observable<void> { return this.http.post<void>('/api/logs/playback-started', { sessionId, channel }); }
  logout(): Observable<void> { return this.http.post<void>('/api/auth/logout', {}); }
  startSession(): Observable<SessionState> { return this.http.post<SessionState>('/api/sessions', {}); }
  currentSession(id: string): Observable<SessionState> { return this.http.get<SessionState>(`/api/sessions/${encodeURIComponent(id)}/current-stream`); }
  sessionAction(id: string, name: string, channel?: string): Observable<SessionState> { return this.http.post<SessionState>(`/api/sessions/${encodeURIComponent(id)}/actions`, { name, channel }); }
  refreshHint(id: string): Observable<unknown> { return this.http.post(`/api/sessions/${encodeURIComponent(id)}/refresh-hint`, {}); }
}
