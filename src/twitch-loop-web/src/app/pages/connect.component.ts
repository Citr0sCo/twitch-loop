import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { ApiService, AuthStatus } from '../core/api.service';

@Component({ selector: 'tl-connect', standalone: true, imports: [CommonModule], templateUrl: './connect.component.html', styleUrl: './connect.component.scss' })
export class ConnectComponent implements OnInit {
  private readonly api = inject(ApiService);
  status: AuthStatus | null = null;
  error = '';

  ngOnInit(): void {
    this.api.authStatus().subscribe({ next: status => this.status = status, error: () => this.error = 'The local API is not available yet.' });
  }

  connect(): void { window.location.href = '/api/auth/twitch/start'; }
}
