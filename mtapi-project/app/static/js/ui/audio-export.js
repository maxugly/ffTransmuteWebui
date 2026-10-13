import { escapeHtml as esc } from '/js/utils.js';

// Reusable codec popup: fields come from server capabilities, not tab assumptions.
export function openAudioExportDialog(format, capabilities, settings, apply) {
  document.querySelector('#audioExportDialog')?.remove();
  const spec = capabilities[format];
  const dialog = document.createElement('dialog');
  dialog.id = 'audioExportDialog';
  dialog.className = 'audio-export-dialog';
  dialog.setAttribute('aria-labelledby', 'audioExportTitle');
  const select = (key, label, values, current, labels = {}) => `<label>${label}<select data-setting="${key}" data-help-title="${label}" data-help-text="Adjust ${label.toLowerCase()} for this export.">${values.map(v=>`<option value="${v}" ${String(v)===String(current)?'selected':''}>${esc(labels[v]||String(v))}</option>`).join('')}</select></label>`;
  const rates = [0, ...(spec.sample_rates || [8000,16000,22050,24000,32000,44100,48000])];
  dialog.innerHTML = `<form method="dialog"><h3 id="audioExportTitle">${esc(spec.label)} export settings</h3><div class="audio-export-fields">
    ${select('channels','Channels',[1,2],settings.channels||1,{1:'Mono',2:'Stereo'})}
    ${select('sample_rate','Sample rate',rates,settings.sample_rate||0,{0:'Keep source'})}
    ${spec.bitrates?select('bitrate','Bitrate (kb/s)',spec.bitrates,settings.bitrate||128):''}
    ${spec.sample_bits?select('sample_bits','Sample depth (bits)',spec.sample_bits,settings.sample_bits||16):''}
    ${spec.compression?`<label>Compression<input data-setting="compression" type="number" min="0" max="12" value="${settings.compression??5}" data-help-title="FLAC compression" data-help-text="0–12; higher uses more encoding time, with the same lossless audio."></label>`:''}
    </div><p class="dream-hint">Stereo duplicates a mono source into two channels.</p><div class="audio-export-actions"><button value="cancel" data-help-title="Cancel" data-help-text="Keep your previous export settings.">Cancel</button><button value="apply" data-help-title="Apply" data-help-text="Use these settings for the next audio export.">Apply</button></div></form>`;
  document.body.append(dialog);
  dialog.querySelector('form').addEventListener('submit', event => {
    if(event.submitter?.value!=='apply')return;
    if(!dialog.querySelector('form').reportValidity()){event.preventDefault();return;}
    const next={};dialog.querySelectorAll('[data-setting]').forEach(el=>next[el.dataset.setting]=Number(el.value));
    apply(next);
  });
  dialog.addEventListener('close',()=>dialog.remove());
  dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close('cancel');}});
  dialog.showModal();
}
