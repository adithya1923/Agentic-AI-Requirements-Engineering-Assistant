export default function StatusPill({ children = 'Draft' }) {
  return <span className="status-pill"><span className="status-dot" />{children}</span>;
}
