import React, { useRef, useCallback } from 'react'
import { Modal } from 'antd'
import type { ModalProps } from 'antd'

/**
 * Ant Design Modal that is draggable by its header bar.
 *
 * Uses a stable `modalRender` (never changes reference) so Ant Design never
 * replaces the modal subtree during a drag — that was causing the React
 * "insertBefore: child not a child of this node" reconciler crash.
 * Dragging now writes directly to containerRef.style.transform without
 * triggering a React state update.
 */
export default function DraggableModal({ afterClose, ...rest }: ModalProps) {
  const posRef = useRef({ x: 0, y: 0 })

  // Stable reference — does NOT depend on pos so React never re-renders.
  const modalRender = useCallback((modal: React.ReactNode) => (
    <ModalWrapper posRef={posRef}>
      {modal}
    </ModalWrapper>
  ), [])

  return (
    <Modal
      {...rest}
      afterClose={() => {
        posRef.current = { x: 0, y: 0 }
        afterClose?.()
      }}
      modalRender={modalRender}
    />
  )
}

interface WrapperProps {
  posRef: React.MutableRefObject<{ x: number; y: number }>
  children: React.ReactNode
}

function ModalWrapper({ posRef, children }: WrapperProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('button') || target.closest('.ant-modal-close')) return

    const header = containerRef.current?.querySelector('.ant-modal-header')
    if (!header?.contains(target)) return

    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const startPosX = posRef.current.x
    const startPosY = posRef.current.y

    const onMove = (ev: MouseEvent) => {
      const x = startPosX + ev.clientX - startX
      const y = startPosY + ev.clientY - startY
      posRef.current = { x, y }
      // Write directly to DOM — no React state update, no reconciliation
      if (containerRef.current) {
        containerRef.current.style.transform = `translate(${x}px, ${y}px)`
      }
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [posRef])

  return (
    <div
      ref={containerRef}
      style={{ transform: `translate(${posRef.current.x}px, ${posRef.current.y}px)` }}
      onMouseDown={onMouseDown}
    >
      <style>{`.ant-modal-header { cursor: move; user-select: none; }`}</style>
      {children}
    </div>
  )
}
