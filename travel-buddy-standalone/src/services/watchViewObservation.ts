export type WatchViewType = 'impression' | 'qualified_view' | 'completion' | 'rewatch';
export interface WatchPlaybackSample {
  isLoaded: boolean;
  isPlaying?: boolean;
  isBuffering?: boolean;
  positionMillis?: number;
  durationMillis?: number;
  didJustFinish?: boolean;
  rate?: number;
}

/** Counts observed forward playback, never load, preload, seek distance or
 * elapsed background time. A serve is only an anchor, not an observation.
 * Existing server thresholds remain 3s qualified / 10s completion. Shorter
 * clips therefore do not produce this legacy completion measure.
 */
export class WatchViewObservation {
  private previous: { at: number; position: number } | null = null;
  private watched = 0;
  private loopWatched = 0;
  private replay = false;
  private seen = new Set<WatchViewType>();

  reset(): void { this.previous=null; this.watched=0; this.loopWatched=0; this.replay=false; this.seen.clear(); }
  pause(): void { this.previous=null; }

  sample(status: WatchPlaybackSample, eligible: boolean, at: number): Array<{ type: WatchViewType; watchedMs: number }> {
    if (!eligible || !status.isLoaded || status.isBuffering || (!status.isPlaying && !status.didJustFinish)
      || !Number.isFinite(status.positionMillis) || !Number.isFinite(at)) { this.pause(); return []; }
    const position=status.positionMillis!;
    const previous=this.previous;
    this.previous={at,position};
    if (!previous) return [];
    const elapsed=at-previous.at;
    const delta=position-previous.position;
    // A delayed callback or a seek provides no evidence of the intervening
    // playback. Normal rate changes cannot turn media distance into time.
    if (elapsed<=0 || elapsed>1500 || delta<=0 || delta>elapsed*Math.max(1,status.rate??1)+250) return [];
    const observed=Math.floor(Math.min(elapsed,delta/Math.max(0.1,status.rate??1)));
    this.watched+=observed; this.loopWatched+=observed;
    const events:Array<{type:WatchViewType;watchedMs:number}>=[];
    const emit=(type:WatchViewType) => { if(!this.seen.has(type)){this.seen.add(type);events.push({type,watchedMs:this.watched});} };
    if(this.watched>=150) emit('impression');
    if(this.watched>=3000) emit('qualified_view');
    if(this.replay && this.loopWatched>=3000) emit('rewatch');
    if(status.didJustFinish){
      if(this.loopWatched>=10000 && status.durationMillis && position>=status.durationMillis-250) emit('completion');
      this.replay=true; this.loopWatched=0; this.previous=null;
    }
    return events;
  }
}
