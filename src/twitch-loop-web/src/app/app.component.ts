import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ApiService, AuthStatus } from './core/api.service';

@Component({
  selector: 'tl-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  status: AuthStatus | null = null;
  logoutError = '';

  ngOnInit(): void {
    this.api.authStatus().subscribe({ next: status => this.status = status });
  }

  logout(): void {
    this.logoutError = '';
    this.api.logout().subscribe({ next: () => { this.status = null; void this.router.navigateByUrl('/connect'); }, error: () => this.logoutError = 'Could not log out.' });
  }
}
