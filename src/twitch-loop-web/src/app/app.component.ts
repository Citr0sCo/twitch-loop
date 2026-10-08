import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { EMPTY, Subscription, catchError, interval, startWith, switchMap } from 'rxjs';
import { ApiService, AuthStatus } from './core/api.service';

@Component({
  selector: 'tl-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  status: AuthStatus | null = null;
  logoutError = '';
  private presenceSubscription: Subscription | null = null;

  ngOnInit(): void {
    this.api.authStatus().subscribe({ next: status => {
      this.status = status;
      if (status.connected) this.startPresenceHeartbeat();
    } });
  }

  ngOnDestroy(): void { this.presenceSubscription?.unsubscribe(); }

  private startPresenceHeartbeat(): void {
    let clientId = sessionStorage.getItem('twitch-loop-client-id');
    if (!clientId) {
      clientId = crypto.randomUUID();
      sessionStorage.setItem('twitch-loop-client-id', clientId);
    }
    this.presenceSubscription = interval(30_000).pipe(
      startWith(0),
      switchMap(() => this.api.clientHeartbeat(clientId).pipe(catchError(() => EMPTY)))
    ).subscribe();
  }

  logout(): void {
    this.logoutError = '';
    this.api.logout().subscribe({ next: () => { this.status = null; this.presenceSubscription?.unsubscribe(); this.presenceSubscription = null; void this.router.navigateByUrl('/connect'); }, error: () => this.logoutError = 'Could not log out.' });
  }
}
