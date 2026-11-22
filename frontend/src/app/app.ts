import {
  ChangeDetectionStrategy, Component, inject, OnInit, viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  mdiCalendarRange, mdiCloudDownloadOutline, mdiFilterVariant, mdiMagnify,
} from '@mdi/js';

import { StoreService } from './services/store.service';
import { ApiService } from './services/api.service';
import { EventsService } from './services/events.service';

import { HeaderComponent } from './components/header/header';
import { DashboardComponent } from './components/dashboard/dashboard';
import { SettingsPanelComponent } from './components/settings-panel/settings-panel';
import { MediaGridComponent } from './components/media-grid/media-grid';
import { BulkBarComponent } from './components/bulk-bar/bulk-bar';
import { QueuePanelComponent } from './components/queue-panel/queue-panel';
import { DetailDrawerComponent } from './components/detail-drawer/detail-drawer';
import { ReviewModalComponent } from './components/review-modal/review-modal';
import { BrowseDialogComponent } from './components/browse-dialog/browse-dialog';
import { IconComponent } from './components/icon/icon';
import { formatDate } from './utils/format-date';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    FormsModule,
    HeaderComponent, DashboardComponent, SettingsPanelComponent,
    MediaGridComponent, BulkBarComponent, QueuePanelComponent,
    DetailDrawerComponent, ReviewModalComponent, BrowseDialogComponent,
    IconComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  readonly formatDate = formatDate;
  readonly store = inject(StoreService);
  private readonly api = inject(ApiService);
  private readonly events = inject(EventsService);

  readonly grid = viewChild.required(MediaGridComponent);
  readonly drawer = viewChild.required(DetailDrawerComponent);
  readonly review = viewChild.required(ReviewModalComponent);
  readonly browse = viewChild.required(BrowseDialogComponent);
  readonly settings = viewChild.required(SettingsPanelComponent);
  readonly settingsPanel = viewChild.required(SettingsPanelComponent);

  readonly mdiCalendarRange = mdiCalendarRange;
  readonly mdiCloudDownloadOutline = mdiCloudDownloadOutline;
  readonly mdiFilterVariant = mdiFilterVariant;
  readonly mdiMagnify = mdiMagnify;

  readonly codecs = ['', 'h264', 'hevc', 'av1', '__other__'];
  readonly codecLabels: Record<string, string> = {
    '': 'All', h264: 'h264', hevc: 'hevc', av1: 'av1', '__other__': 'Other',
  };
  searchDebounce: ReturnType<typeof setTimeout> | null = null;

  /** Subtitle for the "Fetching assets" dialog: media type + size threshold. */
  get loadingSubtitle(): string {
    const m = this.store.media();
    const noun = m === 'image' ? 'Photos' : m === 'motionphoto' ? 'Live Photos' : 'Videos';
    const threshold = m === 'video'
      ? `≥ ${this.store.videoMinGb()} GB`
      : `≥ ${this.store.photoMinMb()} MB`;
    const dateFrom = this.store.captureDateFrom();
    const dateTo = this.store.captureDateTo();
    const dates = dateFrom || dateTo
      ? ` · taken ${dateFrom ? formatDate(dateFrom) : 'any time'} to ${dateTo ? formatDate(dateTo) : 'any time'}`
      : '';
    const metadata = this.store.metadataDescription();
    return `${noun} · ${threshold}${dates}${metadata ? ` · ${metadata}` : ''}`;
  }

  get statusText(): string {
    if (!this.store.loaded()) return 'Ready. Choose Select media above to load media.';
    const s = this.store.queueStats();
    const m = this.store.media();
    const noun = m === 'image' ? 'photos' : m === 'motionphoto' ? 'Live Photos' : 'videos';
    const paused = this.store.queuePause().paused ? ' · paused' : '';
    return `${this.store.total()} ${noun} · ${s.queued} queued · ${s.active} active · ${s.review} review · ${s.done} done · ${s.skipped} skipped · ${s.error} errors${paused}`;
  }

  private applyJobsSnapshot(data: {
    jobs?: Record<string, import('./models/api.models').JobPublic>;
    active: string | null;
    stats?: { saved_bytes?: number };
    pause?: import('./models/api.models').QueuePauseState;
    temp_storage?: import('./models/api.models').TempStorageInfo;
  }): void {
    this.store.jobs.set(data.jobs ?? {});
    this.store.activeId.set(data.active);
    if (data.stats?.saved_bytes !== undefined) {
      this.store.savedBytes.set(data.stats.saved_bytes ?? 0);
    }
    if (data.pause) this.store.queuePause.set(data.pause);
    if (data.temp_storage) this.store.tempStorage.set(data.temp_storage);
  }

  ngOnInit(): void {
    this.loadInitial();
    this.events.connect();
    this.events.jobUpdate$.subscribe(update => {
      this.store.applyJobUpdate(update);
    });
    this.events.queueUpdate$.subscribe(() => {
      this.api.jobs().subscribe(data => this.applyJobsSnapshot(data));
    });
    this.events.tempStorage$.subscribe(storage => {
      this.store.tempStorage.set(storage);
    });
  }

  private loadInitial(): void {
    this.api.status().subscribe(s => {
      this.store.immichUrl.set(s.env?.IMMICH_URL ?? '');
      this.store.immichVersion.set(s.immich_version ?? '');
      this.store.handbrake.set(s.handbrake);
      this.store.ffprobe.set(s.ffprobe);
      this.store.ffmpeg.set(s.ffmpeg);
      if (s.temp_storage) this.store.tempStorage.set(s.temp_storage);
    });
    this.api.capabilities().subscribe(c => this.store.applyCapabilities(c));
    this.api.users().subscribe(data => this.store.users.set(data.users ?? []));
    this.api.keyOwners().subscribe(data => this.store.keyOwners.set(data.owners ?? []));
    this.api.jobs().subscribe(data => {
      this.applyJobsSnapshot(data);
      for (const [id, job] of Object.entries(data.jobs ?? {})) {
        if (job.status === 'done') this.store.markProcessed(id, job);
      }
    });
  }

  onSearch(val: string): void {
    this.store.search.set(val.trim());
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => {
      this.store.page.set(1);
      this.grid().load();
    }, 300);
  }

  setCodec(codec: string): void {
    this.store.codec.set(codec);
    this.store.page.set(1);
    this.grid().load();
  }

  setUser(userId: string): void {
    this.store.userFilter.set(userId);
    this.store.page.set(1);
    this.grid().load();
  }

  onBrowseApply(): void {
    this.grid().load(true);
  }

  onEncode(ids: string[]): void {
    const names: Record<string, string> = {};
    const sizes: Record<string, number> = {};
    const medias: Record<string, string> = {};
    for (const v of this.store.videos()) {
      if (ids.includes(v.id)) { names[v.id] = v.name; sizes[v.id] = v.size; medias[v.id] = v.media; }
    }
    if (this.store.settings().photo_format === 'jxl' && !this.store.jpegXlAvailable()
      && ids.some(id => (medias[id] ?? this.store.media()) === 'image')) {
      this.settingsPanel().open.set(true);
      return;
    }
    this.api.enqueue(ids, names, sizes, { ...this.store.settings(), media: this.store.media() }, medias).subscribe(() => {
      this.api.jobs().subscribe(data => this.applyJobsSnapshot(data));
    });
  }

  onBulkDownload(): void {
    for (const v of this.store.videos()) {
      if (this.store.selected().has(v.id)) {
        window.open(this.api.downloadUrl(v.id, v.name), '_blank');
      }
    }
  }

  onJobsRefresh(): void {
    this.api.jobs().subscribe(data => this.applyJobsSnapshot(data));
  }
}
