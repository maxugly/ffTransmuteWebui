// Sequence Timeline Export (EDL & FCPXML) for DaVinci Resolve. Vanilla ES6, no framework.
import { state, logConsole } from '/app.js?v=4';
import { runOpWithCancel, isMainJobBusy } from '/js/job-control.js';
import { resolveRange, sliceRange } from '/js/pool/sequence-range.js';
import { scheduleSavePoolState } from '/js/pool/persistence.js';
import { basename } from '/js/utils.js';

function triggerDownload(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function updateExportButtons() {
  const btnEdl = document.getElementById('btnExportEdl');
  const btnFcpxml = document.getElementById('btnExportFcpxml');
  const seq = state.pool?.sequence || [];
  const { entries: activeClips } = sliceRange(state.pool?.renderRange, seq);
  const busy = isMainJobBusy();
  const disabled = activeClips.length === 0 || busy;

  if (btnEdl) btnEdl.disabled = disabled;
  if (btnFcpxml) btnFcpxml.disabled = disabled;

  const resOnlyEl = document.getElementById('poolExportResolveOnly');
  const resPresetEl = document.getElementById('poolExportResolvePreset');
  if (resOnlyEl && resPresetEl) {
    resPresetEl.disabled = !resOnlyEl.checked || busy;
  }
}

export async function exportSequenceTimeline(format) {
  if (isMainJobBusy()) {
    logConsole('[TIMELINE EXPORT]: System busy with another operation.', 'warn');
    return;
  }
  const seq = state.pool?.sequence || [];
  if (!seq.length) {
    logConsole('[TIMELINE EXPORT]: Sequence is empty.', 'warn');
    return;
  }
  const { entries: activeClips } = sliceRange(state.pool?.renderRange, seq);
  if (!activeClips.length) {
    logConsole('[TIMELINE EXPORT]: Active sequence range has no clips.', 'warn');
    return;
  }

  const fpsInput = document.getElementById('poolExportFps');
  const fps = parseFloat(fpsInput?.value || state.pool.exportFps) || 30.0;

  const resOnlyInput = document.getElementById('poolExportResolveOnly');
  const resolveOnly = resOnlyInput ? resOnlyInput.checked : !!state.pool.exportResolveOnly;

  const resPresetInput = document.getElementById('poolExportResolvePreset');
  const resolvePreset = resPresetInput?.value || state.pool.exportResolvePreset || 'dnxhr_hq';

  const title = (state.project && state.project.name) ? state.project.name : 'Sequence';

  const clipsPayload = activeClips.map((entry) => {
    const act = entry.conformedPath || entry.variantPath || entry.cleanPath || entry.path;
    const td = (entry.targetDuration != null && entry.targetDuration !== '' && Number(entry.targetDuration) > 0)
      ? Number(entry.targetDuration)
      : null;
    return {
      path: entry.path,
      active_path: act !== entry.path ? act : null,
      target_duration: td,
    };
  });

  const body = {
    clips: clipsPayload,
    format: format,
    fps: fps,
    title: title,
    resolve_only: resolveOnly,
    resolve_preset: resolvePreset,
  };

  logConsole(`[TIMELINE EXPORT]: Starting ${format.toUpperCase()} export (${clipsPayload.length} clips @ ${fps} fps, resolve_only=${resolveOnly})`);

  try {
    const data = await runOpWithCancel('sequence_timeline_export', body, {
      label: `Export ${format.toUpperCase()} (${clipsPayload.length} clips)`,
    });

    if (data && data.ok) {
      const content = data.meta?.content;
      const filename = data.meta?.filename || `${title}.${format === 'edl' ? 'edl' : 'xml'}`;
      const mime = format === 'edl' ? 'text/plain;charset=utf-8' : 'application/xml;charset=utf-8';
      if (content) {
        triggerDownload(content, filename, mime);
      }
      logConsole(`[TIMELINE EXPORT]: Export successful! Saved to ${data.output_path || filename}. Imported via File → Import Timeline in DaVinci Resolve.`);
    } else if (data && !data.ok) {
      logConsole(`[TIMELINE EXPORT]: Export failed: ${data.error || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    logConsole(`[TIMELINE EXPORT]: Export error: ${err.message}`, 'error');
  } finally {
    updateExportButtons();
  }
}
