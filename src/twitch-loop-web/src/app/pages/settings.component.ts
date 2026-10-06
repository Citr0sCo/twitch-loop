import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, FollowingChannel, ScheduleResponse, Settings } from '../core/api.service';

const ANY_FOLLOWING = 'any-following';
const ANY = 'any';

@Component({ selector: 'tl-settings', standalone: true, imports: [CommonModule, FormsModule], templateUrl: './settings.component.html', styleUrl: './settings.component.scss' })
export class SettingsComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  settings: Settings = {
    version: 1,
    keepAwake: true,
    autoMaximiseStream: true,
    maximiseMode: 'theatre',
    browserPollSeconds: 15,
    sessionDurationHours: 24,
    source: 'database'
  };
  settingsLoading = true;
  scheduleLoading = true;
  settingsLoaded = false;
  scheduleLoaded = false;
  settingsError = '';
  scheduleError = '';
  schedule: ScheduleResponse = { version: 1, channels: [ANY_FOLLOWING, ANY] };
  editableChannels: string[] = [];
  selectedLogin = '';
  channelLogin = '';
  following: FollowingChannel[] = [];
  message = '';
  error = '';

  get canSaveSettings(): boolean { return this.settingsLoaded && !this.settingsLoading; }
  get canSaveSchedule(): boolean { return this.scheduleLoaded && !this.scheduleLoading; }

  ngOnInit(): void {
    this.loadSettings();
    this.loadSchedule();
    this.api.following().subscribe({
      next: response => { this.following = [...response.data].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })); this.changeDetector.markForCheck(); },
      error: error => { this.error = error?.error?.detail ?? 'Could not load followed channels. Reconnect with Twitch and try again.'; this.changeDetector.markForCheck(); }
    });
  }

  loadSettings(): void {
    this.settingsLoading = true;
    this.settingsError = '';
    this.api.settings().subscribe({
      next: settings => {
        this.settingsLoading = false;
        if (!settings) {
          this.settingsLoaded = false;
          this.settingsError = 'The settings response was empty.';
          this.changeDetector.markForCheck();
          return;
        }
        this.settings = settings;
        this.settingsLoaded = true;
        this.changeDetector.markForCheck();
      },
      error: () => {
        this.settingsLoading = false;
        this.settingsLoaded = false;
        this.settingsError = 'Could not load settings.';
        this.changeDetector.markForCheck();
      }
    });
  }

  loadSchedule(): void {
    this.scheduleLoading = true;
    this.scheduleError = '';
    this.api.schedule().subscribe({
      next: schedule => {
        this.scheduleLoading = false;
        if (!schedule || !Array.isArray(schedule.channels)) {
          this.scheduleLoaded = false;
          this.scheduleError = 'The priority list response was invalid.';
          this.changeDetector.markForCheck();
          return;
        }
        this.schedule = schedule;
        this.editableChannels = schedule.channels.filter(channel => !this.isAutomatic(channel));
        this.scheduleLoaded = true;
        this.changeDetector.markForCheck();
      },
      error: () => {
        this.scheduleLoading = false;
        this.scheduleLoaded = false;
        this.scheduleError = 'Could not load the priority list.';
        this.changeDetector.markForCheck();
      }
    });
  }

  addChannel(login: string): void {
    const normalized = login.trim().toLowerCase();
    if (normalized && !this.editableChannels.some(channel => channel.toLowerCase() === normalized)) this.editableChannels.push(normalized);
    this.selectedLogin = '';
    this.channelLogin = '';
  }

  removeChannel(index: number): void { this.editableChannels.splice(index, 1); }
  moveChannel(index: number, direction: -1 | 1): void {
    const next = index + direction;
    if (next < 0 || next >= this.editableChannels.length) return;
    [this.editableChannels[index], this.editableChannels[next]] = [this.editableChannels[next], this.editableChannels[index]];
  }

  channelName(login: string): string { return this.following.find(channel => channel.login.toLowerCase() === login.toLowerCase())?.name ?? login; }
  isAutomatic(channel: string): boolean { return channel === ANY_FOLLOWING || channel === ANY; }

  saveSettings(): void {
    if (!this.canSaveSettings) return;
    this.error = ''; this.message = '';
    this.api.saveSettings(this.settings).subscribe({
      next: settings => { this.settings = settings; this.message = 'Playback settings saved.'; this.changeDetector.markForCheck(); },
      error: () => { this.error = 'Settings were changed elsewhere or are invalid.'; this.changeDetector.markForCheck(); }
    });
  }

  saveSchedule(): void {
    if (!this.canSaveSchedule) return;
    this.error = ''; this.message = '';
    const channels = [...this.editableChannels, ANY_FOLLOWING, ANY];
    this.api.saveSchedule({ ...this.schedule, channels }).subscribe({
      next: response => {
        this.schedule = response;
        this.editableChannels = response.channels.filter(channel => !this.isAutomatic(channel));
        this.message = 'Priority list saved. Changes apply on the next evaluation.';
        this.changeDetector.markForCheck();
      },
      error: error => { this.error = error?.error?.errors?.join(' ') ?? 'Priority list is invalid.'; this.changeDetector.markForCheck(); }
    });
  }
}
