// Melon's play bar alternates between the recording credit and synchronized lyrics.
// Retain the credit for this playback only, including while playback is paused.
export function trackReader(lookup,changed) {
  let previous, track, generation=0, pending=false, retryAt=0;
  return (status,now=Date.now())=>{
    const elapsed=status.elapsed, old=previous?.elapsed;
    const jumped=Number.isFinite(old) && Number.isFinite(elapsed) &&
      (elapsed<old-1 || elapsed>old+(now-previous.at)/1000+3);
    const named=Boolean(status.title && status.artist);
    if (!status.running || status.pid!==previous?.pid || status.duration!==previous?.duration || jumped ||
        (track && named && (status.title!==track.title || status.artist!==track.artist))) {
      generation++; track=null; pending=false; retryAt=0;
    }
    previous={...status,at:now};
    if (named) track={...track,title:status.title,artist:status.artist};
    if (status.running && status.duration>0 && !track && !pending && now>=retryAt) {
      const owner=generation;
      pending=true;
      retryAt=now+60000;
      lookup().then(record=>{
        if(owner!==generation || !record?.title || !record.artist) return;
        if(track && (track.title!==record.title || track.artist!==record.artist)) return;
        track=record;
        changed({...previous,...track});
      }).catch(()=>{}).finally(()=>{if(owner===generation) pending=false;});
    }
    return track?{...status,...track}:status;
  };
}
