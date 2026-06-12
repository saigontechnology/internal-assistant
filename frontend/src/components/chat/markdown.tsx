import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

/**
 * Shared markdown renderer for everything the chat surface shows — final
 * messages and intermediate tool-call results. The single point of truth
 * for citation behavior:
 *
 *   - links always open in a new tab (target=_blank)
 *   - rel="noopener noreferrer" so the destination (a SharePoint origin we
 *     don't control) can't reach back through window.opener and can't
 *     leak the Referer.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children, ...rest }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            {...rest}
          >
            {children}
          </a>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  )
}
