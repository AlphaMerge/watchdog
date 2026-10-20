import { Fragment, type ReactNode } from 'react';
import { parseInline, type InlineNode } from './inline-markdown';

/**
 * A description as its author wrote it: code, emphasis and strong emphasis drawn, not typed out
 * (`U-89`). `inline-markdown.ts` says what is read and why.
 *
 * **Set off by colour, not by face** (`index.css`'s first rule). The whole UI is monospace, so a
 * code span in its own face would look like the words beside it; in the body colour it stands out
 * of the muted line it sits in, as `Overview`'s `<strong>` does, and `<code>` still says what it
 * is to anything reading the markup.
 */
export function InlineMarkdown({ text }: { text: string }): React.JSX.Element {
  return <>{draw(parseInline(text))}</>;
}

function draw(nodes: readonly InlineNode[]): ReactNode[] {
  return nodes.map((node, at) => {
    switch (node.kind) {
      case 'text':
        return <Fragment key={at}>{node.text}</Fragment>;
      case 'code':
        return (
          <code key={at} className="font-mono text-text">
            {node.text}
          </code>
        );
      case 'strong':
        return (
          <strong key={at} className="font-medium text-text">
            {draw(node.children)}
          </strong>
        );
      case 'em':
        return <em key={at}>{draw(node.children)}</em>;
    }
  });
}
