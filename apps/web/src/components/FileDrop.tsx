import { useEffect, useRef, useState } from 'react';

/** Drag with files anywhere in the window shows the drop overlay. */
export function useFileDrop(enabled: boolean, onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  const filesRef = useRef(onFiles);
  filesRef.current = onFiles;
  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setOver(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const overFn = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      filesRef.current([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overFn);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('drop', drop);
    };
  }, [enabled]);
  return over;
}

/** "Pudota tiedostot tähän" over the whole window while files are dragged. */
export function DropOverlay() {
  return (
    <div className="pointer-events-none fixed inset-0 z-(--z-toast) bg-background/90">
      <div className="absolute inset-4 flex items-center justify-center rounded-xl border-2 border-dashed border-border text-heading">
        Pudota tiedostot tähän
      </div>
    </div>
  );
}
