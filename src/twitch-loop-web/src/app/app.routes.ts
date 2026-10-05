import { Routes } from '@angular/router';
import { ConnectComponent } from './pages/connect.component';
import { SettingsComponent } from './pages/settings.component';
import { WatchComponent } from './pages/watch.component';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'connect' },
  { path: 'connect', component: ConnectComponent },
  { path: 'watch', component: WatchComponent },
  { path: 'settings', component: SettingsComponent },
  { path: '**', redirectTo: 'connect' }
];
