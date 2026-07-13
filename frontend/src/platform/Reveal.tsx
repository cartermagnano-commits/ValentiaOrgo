'use client'

import { cloneElement, isValidElement, ReactElement } from 'react'

/**
 * Entrance animation wrapper. Clones its single child and adds the
 * `reveal-up` class (fade + rise, see App.css) without introducing an
 * extra DOM node — safe inside CSS grid/flex parents.
 *
 * `delay` (ms) staggers siblings: pass e.g. index * 45.
 */
export default function Reveal({
  children,
  delay = 0,
}: {
  children: ReactElement
  delay?: number
}) {
  if (!isValidElement(children)) return children
  const el = children as ReactElement<{ className?: string; style?: React.CSSProperties }>
  return cloneElement(el, {
    className: [el.props.className, 'reveal-up'].filter(Boolean).join(' '),
    style: delay ? { ...el.props.style, animationDelay: `${delay}ms` } : el.props.style,
  })
}
