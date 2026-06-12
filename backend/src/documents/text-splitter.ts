import type { TextChunk } from '../common/types.js'

const DEFAULT_SEPARATORS = ['\n\n', '\n', '. ', ' ', '']

/**
 * Pure recursive splitter — ported as-is from src/lib/text-splitter.ts. Kept
 * out of any class so it stays trivially testable.
 */
export function splitText(
  text: string,
  metadata: Record<string, string>,
  chunkSize: number,
  chunkOverlap: number,
): TextChunk[] {
  const chunks = recursiveSplit(text, DEFAULT_SEPARATORS, chunkSize)

  return chunks
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk, i) => ({
      text: chunk,
      metadata: { ...metadata, chunk_index: String(i) },
    }))

  function recursiveSplit(input: string, separators: string[], maxLen: number): string[] {
    if (input.length <= maxLen) return [input]
    const sep = separators[0]
    if (!sep && sep !== '') return [input.slice(0, maxLen)]
    const remaining = separators.slice(1)
    const parts = sep === '' ? [...input] : input.split(sep)
    const result: string[] = []
    let current = ''
    for (const part of parts) {
      const candidate = current ? current + sep + part : part
      if (candidate.length <= maxLen) {
        current = candidate
      } else {
        if (current) result.push(current)
        if (part.length > maxLen) {
          result.push(...recursiveSplit(part, remaining, maxLen))
          current = ''
        } else {
          current = part
        }
      }
    }
    if (current) result.push(current)
    if (chunkOverlap > 0 && result.length > 1) return applyOverlap(result, chunkOverlap)
    return result
  }
}

function applyOverlap(chunks: string[], overlap: number): string[] {
  if (chunks.length <= 1) return chunks
  const result: string[] = [chunks[0]]
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1]
    const overlapText = prev.slice(-overlap)
    result.push(overlapText + chunks[i])
  }
  return result
}
