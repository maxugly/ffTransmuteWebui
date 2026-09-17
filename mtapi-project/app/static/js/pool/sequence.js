// Extracted from pool/sequence.js — see sequence.js barrel. Vanilla ES6, no framework.
// Barrel — split of the former 2615-line god-file. Importers (app.js, grid.js,
// items.js, persistence.js, preview.js, jobs.js) keep importing from here.
// New code should import from the leaf modules directly.
export { findPoolItem, seqEntryPlayDuration, sequenceTotalDuration, updateSeqTotalTime } from '/js/pool/sequence-model.js';
export { displayFocusPath, setPoolHover, clearPoolHover, setPoolFocus, updateSelectionHighlights, updatePoolFocusFrame } from '/js/pool/sequence-select.js';
export { setupSequenceDropZone, addPathToSequence, addPathsToSequence, removeSequenceAt, clearSequence, renderSequenceBox, applySeqTokenSize, setSeqTokenSize } from '/js/pool/sequence-composer.js';
export { updateSeqTransportUI, findSelectedSeqIndex, moveSelectedInSequence, updateSeqClipSettings, onSeqClipDurationChange, applySeqTokenTimeStyles, seqClipSpeedInfo, seqClipTokenTitle, seqLoadClip, seqPlay, seqPause, seqStop, seqPrev, seqNext, _detachPlaybackVideo } from '/js/pool/sequence-transport.js';
export { peekVariants, _showSeqVariantMenu, _fetchVariants, _fetchVariantsBatch } from '/js/pool/sequence-variants.js';
export { refreshRifeNeed, attachCachedRifeVariants, recoverSequenceVariants, setInstantHydrationGate, armInstantRife, disarmInstantRife, ensureSequenceMetaAndInstantScan, _maybeAutoRifeAll, getInstantRifeQueueSnapshot } from '/js/pool/sequence-rife.js';
export { conformBadgeForEntry, updateStitchButton, invalidateConforms, maybeAutoConformEntry, noteConformDone } from '/js/pool/sequence-conform.js';
export { SEQ_TAG_COLORS, normTagColor, sequenceUseCounts, setEntryTagColor, openTagPicker, closeTagPicker } from '/js/pool/sequence-tag.js';
export { ensureSequenceLineages, eraseLineageId, eraseBadgeForEntry, updateErasePanel, runErasePipeline, clearEraseStatus, initSequenceErase } from '/js/pool/sequence-erase.js?v=2';
