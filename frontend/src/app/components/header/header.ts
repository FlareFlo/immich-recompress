import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import {
  mdiImageSearchOutline,
  mdiServerOutline,
  mdiTune,
  mdiWeatherNight,
  mdiWeatherSunny,
} from '@mdi/js';
import { TempStorageInfo } from '../../models/api.models';
import { StoreService } from '../../services/store.service';
import { ThemeService } from '../../services/theme.service';
import { formatBytes } from '../../utils/format-bytes';
import { IconComponent } from '../icon/icon';

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './header.html',
  styleUrl: './header.css',
})
export class HeaderComponent {
  readonly store = inject(StoreService);
  readonly theme = inject(ThemeService);
  readonly browseClick = output<void>();
  readonly settingsClick = output<void>();

  readonly mdiImageSearchOutline = mdiImageSearchOutline;
  readonly mdiServerOutline = mdiServerOutline;
  readonly mdiTune = mdiTune;
  readonly mdiWeatherNight = mdiWeatherNight;
  readonly mdiWeatherSunny = mdiWeatherSunny;

  tempTooltip(tmp: TempStorageInfo): string {
    const appNote = tmp.app_bytes > 0 ? ` · ${formatBytes(tmp.app_bytes)} held by queue/review` : '';
    return `${tmp.path}: ${formatBytes(tmp.used)} / ${formatBytes(tmp.total)} used (${formatBytes(tmp.free)} free${appNote}) · auto-pauses at ${tmp.max_used_pct}% or ≤ ${formatBytes(tmp.min_free_bytes)} free`;
  }
}
