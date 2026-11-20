// Melon's play bar alternates between the recording credit and synchronized lyrics.
// Keep credits through that transition, but recheck them while the title is hidden.
export function trackReader(lookup,changed) {
  let previous,previousAt,track,generation=0,pending=false,nextLookupAt=0,failures=0;

  function invalidate() {
    generation++;
    track=undefined;
    pending=false;
    nextLookupAt=0;
    failures=0;
  }

  function read(status,now=Date.now()) {
    const elapsed=status.elapsed,old=previous?.elapsed;
    const jumped=Number.isFinite(old) && Number.isFinite(elapsed) &&
      (elapsed<old-1 || elapsed>old+(now-previousAt)/1000+3);
    const named=Boolean(status.title && status.artist);
    const differentCredit=track && named && (status.title!==track.title || status.artist!==track.artist);
    if (!status.running || status.pid!==previous?.pid || status.duration!==previous?.duration || jumped || differentCredit) invalidate();
    previous=status;
    previousAt=now;
    if (named) track={...track,title:status.title,artist:status.artist};

    if (status.running && status.duration>0 && !named && !pending && now>=nextLookupAt) {
      const owner=generation;
      pending=true;
      // A successful credit stays useful while a periodic check is in progress.
      nextLookupAt=now+30000;
      lookup(()=>owner===generation).then(record=>{
        if (owner!==generation) return;
        if (!record?.title || !record.artist) throw Error('곡 정보를 읽을 수 없습니다');
        // The play bar may reveal a new song while this lookup is answering.
        if (previous.title && previous.artist &&
            (previous.title!==record.title || previous.artist!==record.artist)) return;
        track=record;
        failures=0;
        nextLookupAt=previousAt+30000;
        changed({...previous,...track});
      }).catch(()=>{
        if (owner!==generation) return;
        failures++;
        nextLookupAt=previousAt+Math.min(30000,2000*2**Math.min(failures-1,4));
      }).finally(()=>{
        if (owner===generation) pending=false;
      });
    }
    return track?{...status,...track}:status;
  }

  read.invalidate=invalidate;
  return read;
}
