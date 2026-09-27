import { Link, useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from '../api.js';

function humanize(value) {
  return value.toLowerCase().replaceAll('_', ' ');
}

export default function InputDetail() {
  const { projectId, inputId } = useParams();
  const [record, setRecord] = useState(null);
  const [content, setContent] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api.input(inputId)
      .then(async (metadata) => {
        if (!active) return;
        if (metadata.projectId !== projectId) throw new Error('This input does not belong to the selected project.');
        setRecord(metadata);
        if (metadata.processingStatus === 'READY') {
          const body = await api.inputContent(inputId);
          if (active) setContent(body);
        }
      })
      .catch((requestError) => { if (active) setError(requestError.message); });
    return () => { active = false; };
  }, [inputId, projectId]);

  return (
    <section className="page-section input-detail-page">
      <Link className="back-link" to={`/projects/${projectId}`}>← Back to project</Link>
      {error ? <p className="state-error" role="alert">{error}</p> : !record ? <p className="state-message">Loading source input…</p> : <>
        <div className="input-detail-header"><div><span className="eyebrow">SOURCE INPUT</span><h1>{record.title}</h1><p>{record.source}</p></div><span className={`processing-state ${record.processingStatus.toLowerCase()}`}>{humanize(record.processingStatus)}</span></div>
        <dl className="input-metadata">
          <div><dt>Input type</dt><dd>{humanize(record.inputType)}</dd></div>
          <div><dt>Source / origin</dt><dd>{record.source}</dd></div>
          <div><dt>Original filename</dt><dd>{record.originalFilename || 'Text entry'}</dd></div>
          <div><dt>Created</dt><dd>{new Date(record.createdAt).toLocaleString()}</dd></div>
          <div><dt>Updated</dt><dd>{new Date(record.updatedAt).toLocaleString()}</dd></div>
          {record.fileSizeBytes !== null && <div><dt>File size</dt><dd>{(record.fileSizeBytes / 1024).toFixed(1)} KB</dd></div>}
        </dl>
        {record.processingError && <p className="input-processing-error" role="status">{record.processingError}</p>}
        <article className="input-content-panel"><span className="eyebrow">{content?.contentKind === 'EXTRACTED' ? 'EXTRACTED TEXT' : 'SUBMITTED CONTENT'}</span><pre>{content?.content || record.processingError || 'No content is available.'}</pre></article>
      </>}
    </section>
  );
}
