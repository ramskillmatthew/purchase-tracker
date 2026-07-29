"use client";

import { useRef, useState } from "react";

const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif";

/**
 * One polished panel — a single clear "Choose photos" primary action, a
 * visually secondary "Choose folder" action, and the whole panel doubles
 * as the drag-and-drop target (UX refinement spec §3). Both pickers are
 * real <label>/<input type="file"> pairs, so the whole panel stays fully
 * keyboard-accessible without any custom click handling.
 */
export default function UploadDropzone({ onFilesSelected, disabled }: {
  onFilesSelected: (files: File[]) => void;
  disabled?: boolean;
}) {
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  function handleFiles(fileList: FileList | null) {
    if (!fileList || disabled) return;
    onFilesSelected(Array.from(fileList));
  }

  return <div
    className={`listing-dropzone${dragOver ? " listing-dropzone-active" : ""}`}
    onDragOver={event => { event.preventDefault(); if (!disabled) setDragOver(true); }}
    onDragLeave={() => setDragOver(false)}
    onDrop={event => {
      event.preventDefault();
      setDragOver(false);
      if (!disabled) handleFiles(event.dataTransfer.files);
    }}
  >
    <p className="listing-dropzone-title">Upload product photos</p>
    <p className="listing-dropzone-hint">Drag photos here or click below</p>
    <div className="listing-dropzone-actions">
      <label className="button listing-dropzone-primary">
        Choose photos
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT}
          multiple
          disabled={disabled}
          onChange={event => { handleFiles(event.target.files); event.target.value = ""; }}
        />
      </label>
      <label className="button-secondary listing-dropzone-secondary">
        Choose folder
        <input
          // webkitdirectory/directory are unstandardised (absent from
          // React's typed input props) but broadly supported where folder
          // selection is possible at all — set imperatively via the ref
          // rather than an `any`-typed prop spread. Never relied on for
          // anything beyond a convenience picker; subfolder names are
          // shown as optional context only, never trusted grouping.
          ref={element => {
            folderInputRef.current = element;
            if (element) {
              (element as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
              element.setAttribute("directory", "");
            }
          }}
          type="file"
          accept={ACCEPT}
          multiple
          disabled={disabled}
          onChange={event => { handleFiles(event.target.files); event.target.value = ""; }}
        />
      </label>
    </div>
    <p className="listing-dropzone-formats">Supported: JPG • PNG • WEBP • HEIC</p>
  </div>;
}
