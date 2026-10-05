import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
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
  status: AuthStatus | null = null;

  ngOnInit(): void {
    this.api.authStatus().subscribe({ next: status => this.status = status });
  }
}
