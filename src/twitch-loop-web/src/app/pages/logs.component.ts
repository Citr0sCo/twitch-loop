import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from '@angular/core';
import { EMPTY, Subscription, catchError, interval, startWith, switchMap } from 'rxjs';
import { ApiService, SiteEvent } from '../core/api.service';

@Component({
  selector: 'tl-logs',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './logs.component.html',
  styleUrl: './logs.component.scss'
})
export class LogsComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private subscription: Subscription | null = null;
  events: SiteEvent[] = [];
  loading = true;
  error = '';

  ngOnInit(): void {
    this.subscription = interval(15_000).pipe(
      startWith(0),
      switchMap(() => this.api.recentEvents().pipe(catchError(() => {
        this.error = 'Could not load recent events. Retrying automatically.';
        this.loading = false;
        this.changeDetector.markForCheck();
        return EMPTY;
      })))
    ).subscribe(events => {
      this.events = events;
      this.error = '';
      this.loading = false;
      this.changeDetector.markForCheck();
    });
  }

  ngOnDestroy(): void { this.subscription?.unsubscribe(); }

  category(type: string): string {
    if (type.startsWith('stream_')) return 'stream';
    if (type.startsWith('client_')) return type === 'client_disconnected' ? 'disconnect' : 'client';
    if (type.includes('updated') || type.startsWith('automation_')) return 'configuration';
    if (type.includes('connected') || type.includes('logged_out')) return 'account';
    return 'activity';
  }
}
