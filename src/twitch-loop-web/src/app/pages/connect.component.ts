import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { ApiService, AuthStatus } from '../core/api.service';

@Component({ selector: 'tl-connect', standalone: true, imports: [CommonModule], templateUrl: './connect.component.html', styleUrl: './connect.component.scss' })
export class ConnectComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  status: AuthStatus | null = null;
  error = '';

  ngOnInit(): void {
    if (this.route.snapshot.queryParamMap.get('error') === 'owner_mismatch') {
      this.error = 'This Twitch account is not the configured owner. Sign in with the whitelisted Twitch account or update APP_ALLOWED_OWNER_TWITCH_LOGIN with that account’s Twitch login.';
    }
    this.api.authStatus().subscribe({ next: status => this.status = status, error: () => this.error = 'The local API is not available yet.' });
  }

  connect(): void { window.location.href = '/api/auth/twitch/start'; }
}
