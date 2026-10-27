import ReactMarkdown from 'react-markdown';

/** react-markdown does not render raw HTML, so user/AI-authored text cannot inject markup. */
export function Markdown({ children }: { children: string }) {
  return <div className="md"><ReactMarkdown>{children}</ReactMarkdown></div>;
}
