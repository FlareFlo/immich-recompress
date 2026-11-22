import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { JobPublic } from '../../models/api.models';
import { StoreService } from '../../services/store.service';
import { QueuePanelComponent } from './queue-panel';

const reviewed = (id: string): JobPublic => ({
  id, name: `${id}.dng`, media: 'image', status: 'review', codec: 'dng',
  old_size: 100 * 1024 * 1024, new_size: 40 * 1024 * 1024,
} as JobPublic);

describe('replace all media', () => {
  let fixture: ComponentFixture<QueuePanelComponent>;
  let store: StoreService;
  let http: HttpTestingController;

  const element = (): HTMLElement => fixture.nativeElement;
  const button = (label: string) => [...element().querySelectorAll('button')]
    .find(b => b.textContent!.trim() === label);
  const show = async (...ids: string[]) => {
    store.jobs.set(Object.fromEntries(ids.map(id => [id, reviewed(id)])));
    await fixture.whenStable();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [QueuePanelComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(QueuePanelComponent);
    store = TestBed.inject(StoreService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('stays out of the way for a single review', async () => {
    await show('one');
    expect(element().querySelector('.replace-all')).toBeNull();
  });

  it('counts the reviews and states what they reclaim together', async () => {
    await show('one', 'two', 'three');
    expect(button('Replace all media (3)')).toBeTruthy();
    expect(element().querySelector('.replace-all')!.textContent).toContain('180.0 MB');
  });

  it('never replaces on the first click', async () => {
    await show('one', 'two');
    button('Replace all media (2)')!.click();
    await fixture.whenStable();
    http.expectNone('/api/confirm-all');
    expect(element().querySelector('.replace-all')!.textContent).toContain('Replace 2 originals in Immich?');
  });

  it('sends the reviews on screen once confirmed, then refreshes', async () => {
    const refreshed = vi.fn();
    fixture.componentInstance.jobsRefresh.subscribe(refreshed);
    await show('one', 'two');
    button('Replace all media (2)')!.click();
    await fixture.whenStable();
    button('Replace 2')!.click();
    const request = http.expectOne('/api/confirm-all');
    expect(request.request.body).toEqual({ ids: ['one', 'two'] });
    request.flush({ confirmed: ['one', 'two'], skipped: [] });
    expect(refreshed).toHaveBeenCalled();
  });

  it('backs out without touching anything', async () => {
    await show('one', 'two');
    button('Replace all media (2)')!.click();
    await fixture.whenStable();
    button('Cancel')!.click();
    await fixture.whenStable();
    http.expectNone('/api/confirm-all');
    expect(button('Replace all media (2)')).toBeTruthy();
  });

  it('forgets the first click once the bar has gone', async () => {
    await show('one', 'two');
    button('Replace all media (2)')!.click();
    await fixture.whenStable();
    await show('one');
    await show('one', 'two');
    expect(button('Replace all media (2)')).toBeTruthy();
  });
});

describe('finished skips', () => {
  let fixture: ComponentFixture<QueuePanelComponent>;
  let store: StoreService;

  const skipped = (changes: Partial<JobPublic>): JobPublic => ({
    id: 'one', name: 'IMG_8138.MOV', media: 'video', status: 'skipped',
    log: 'Source is already HEVC, which is on the skip list (Skip Codecs in Video settings)',
    skip_reason: 'HEVC', old_size: 3_500_000_000, new_size: null, ...changes,
  } as JobPublic);
  const finished = (): HTMLElement => fixture.nativeElement.querySelector('[aria-label="Finished"]');
  const show = async (job: JobPublic) => {
    store.jobs.set({ [job.id]: job });
    await fixture.whenStable();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [QueuePanelComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(QueuePanelComponent);
    store = TestBed.inject(StoreService);
  });

  it('names the reason and explains it on hover', async () => {
    await show(skipped({}));
    const badge = finished().querySelector<HTMLElement>('.badge')!;
    expect(badge.textContent!.trim()).toBe('skipped · HEVC');
    expect(badge.title).toContain('already HEVC');
  });

  it('shows a skip below the minimum as a skip, not as a saving', async () => {
    await show(skipped({ skip_reason: '<10% saved', log: 'Savings 6.0% < 10%', old_size: 100, new_size: 94 }));
    expect(finished().querySelector('.badge')!.textContent!.trim()).toBe('skipped · <10% saved');
    expect(finished().querySelector('li .text-success')).toBeNull();
  });
});

describe('temp storage and queue pause', () => {
  let fixture: ComponentFixture<QueuePanelComponent>;
  let store: StoreService;
  let http: HttpTestingController;

  const gib = 1024 ** 3;
  const element = (): HTMLElement => fixture.nativeElement;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [QueuePanelComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(QueuePanelComponent);
    store = TestBed.inject(StoreService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('displays temp storage usage and app intermediate bytes', async () => {
    store.tempStorage.set({
      path: '/tmp/immich_recompress_ui',
      total: 20 * gib,
      used: 5 * gib,
      free: 15 * gib,
      used_pct: 25,
      app_bytes: 2 * gib,
      work_bytes: gib,
      backup_bytes: gib,
      max_used_pct: 90,
      min_free_bytes: gib,
      low_space: false,
    });
    await fixture.whenStable();
    const card = element().querySelector('[aria-label="Temp storage"]')!;
    expect(card.textContent).toContain('5.0 GB / 20.0 GB (25%)');
    expect(card.textContent).toContain('2.0 GB held for queue/review');
    expect(card.textContent).toContain('15.0 GB free');
  });

  it('shows pause banner and triggers resume request', async () => {
    const refreshed = vi.fn();
    fixture.componentInstance.jobsRefresh.subscribe(refreshed);
    store.tempStorage.set({
      path: '/tmp/immich_recompress_ui',
      total: 10 * gib,
      used: 9.2 * gib,
      free: 0.8 * gib,
      used_pct: 92,
      app_bytes: 3 * gib,
      work_bytes: gib,
      backup_bytes: 2 * gib,
      max_used_pct: 90,
      min_free_bytes: gib,
      low_space: true,
    });
    store.queuePause.set({
      paused: true,
      manual: false,
      auto: true,
      reason: 'Temp storage is 92% full (819.2 MB free)',
    });
    await fixture.whenStable();

    const card = element().querySelector('[aria-label="Temp storage"]')!;
    expect(card.textContent).toContain('Queue paused');
    expect(card.textContent).toContain('Temp storage is 92% full');

    const resumeBtn = [...card.querySelectorAll('button')].find(b => b.textContent!.includes('Resume'))!;
    resumeBtn.click();
    const req = http.expectOne('/api/queue/resume');
    req.flush({
      ok: true,
      pause: { paused: false, manual: false, auto: false, reason: null },
      temp_storage: store.tempStorage(),
    });
    expect(store.queuePause().paused).toBe(false);
    expect(refreshed).toHaveBeenCalled();
  });

  it('allows manual pause when jobs are waiting', async () => {
    store.tempStorage.set({
      path: '/tmp/immich_recompress_ui',
      total: 20 * gib,
      used: 2 * gib,
      free: 18 * gib,
      used_pct: 10,
      app_bytes: 0,
      work_bytes: 0,
      backup_bytes: 0,
      max_used_pct: 90,
      min_free_bytes: gib,
      low_space: false,
    });
    store.jobs.set({
      one: { id: 'one', name: 'clip.mp4', status: 'queued', media: 'video' } as JobPublic,
    });
    await fixture.whenStable();

    const card = element().querySelector('[aria-label="Temp storage"]')!;
    const pauseBtn = [...card.querySelectorAll('button')].find(b => b.textContent!.includes('Pause'))!;
    pauseBtn.click();
    const req = http.expectOne('/api/queue/pause');
    req.flush({
      ok: true,
      pause: { paused: true, manual: true, auto: false, reason: 'Paused by user' },
      temp_storage: store.tempStorage(),
    });
    expect(store.queuePause().paused).toBe(true);
  });
});
