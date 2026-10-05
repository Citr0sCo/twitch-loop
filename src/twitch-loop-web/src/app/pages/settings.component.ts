import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, ScheduleResponse, ScheduleSlot, Settings } from '../core/api.service';

interface EditableSlot extends ScheduleSlot { channelsText: string; }

@Component({ selector: 'tl-settings', standalone: true, imports: [CommonModule, FormsModule], templateUrl: './settings.component.html', styleUrl: './settings.component.scss' })
export class SettingsComponent implements OnInit {
  private readonly api = inject(ApiService);
  settings: Settings | null = null;
  schedule: ScheduleResponse = { version: 1, timeZone: 'UTC', slots: [] };
  editableSlots: EditableSlot[] = [];
  message = '';
  error = '';

  ngOnInit(): void {
    this.api.settings().subscribe({ next: settings => this.settings = settings, error: () => this.error = 'Could not load settings.' });
    this.api.schedule().subscribe({ next: schedule => { this.schedule = schedule; this.editableSlots = schedule.slots.map(slot => ({ ...slot, channelsText: slot.channels.join(', ') })); }, error: () => this.error = 'Could not load schedule.' });
  }

  addSlot(): void { this.editableSlots.push({ id: crypto.randomUUID(), enabled: true, startTime: '12:00', channels: [], channelsText: '' }); }
  removeSlot(index: number): void { this.editableSlots.splice(index, 1); }
  move(index: number, direction: -1 | 1): void { const next = index + direction; if (next < 0 || next >= this.editableSlots.length) return; [this.editableSlots[index], this.editableSlots[next]] = [this.editableSlots[next], this.editableSlots[index]]; }

  save(): void {
    if (!this.settings) return;
    this.error = ''; this.message = '';
    const slots = this.editableSlots.map(({ channelsText, ...slot }) => ({ ...slot, channels: channelsText.split(',').map(channel => channel.trim()).filter(Boolean) }));
    this.api.saveSettings(this.settings).subscribe({ next: settings => { this.settings = settings; this.saveSchedule(slots); }, error: () => this.error = 'Settings were changed elsewhere or are invalid.' });
  }

  private saveSchedule(slots: ScheduleSlot[]): void {
    this.api.saveSchedule({ ...this.schedule, version: this.schedule.version, slots }).subscribe({ next: response => { this.schedule = response; this.message = 'Settings saved. Changes apply on the next evaluation.'; }, error: error => this.error = error?.error?.errors?.join(' ') ?? 'Schedule is invalid.' });
  }
}
