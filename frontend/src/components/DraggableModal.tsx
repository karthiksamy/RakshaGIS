import React, { useRef, useState, useCallback } from 'react'
import { Modal } from 'antd'
import type { ModalProps } from 'antd'

/**
 * Ant Design Modal that is draggable by its header bar.
 * Works by attaching a mousedown listener to the rendered .ant-modal-header element
 * so the FULL header area acts as a drag handle, not just the title text.
 */
export default function DraggableModal({ afterClose, ...rest }: ModalProps) {
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const posRef = useRef({ x: 0, y: 0 })

  const modalRender = useCallback((modal: React.ReactNode) => (
    <ModalWrapper pos={pos} posRef={posRef} setPos={setPos}>
      {modal}
    </ModalWrapper>
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [pos.x, pos.y])

  return (
    <Modal
      {...rest}
      afterClose={() => {
        posRef.current = { x: 0, y: 0 }
        setPos({ x: 0, y: 0 })
        afterClose?.()
      }}
      modalRender={modalRender}
    />
  )
}

interface WrapperProps {
  pos: { x: number; y: number }
  posRef: React.MutableRefObject<{ x: number; y: number }>
  setPos: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>
  children: React.ReactNode
}

function ModalWrapper({ pos, posRef, setPos, children }: WrapperProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Only start drag when clicking the header area (not buttons inside it)
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
      const next = {
        x: startPosX + ev.clientX - startX,
        y: startPosY + ev.clientY - startY,
      }
      posRef.current = next
      setPos(next)
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [posRef, setPos])

  return (
    <div
      ref={containerRef}
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
      onMouseDown={onMouseDown}
    >
      <style>{`.ant-modal-header { cursor: move; user-select: none; }`}</style>
      {children}
    </div>
  )
}
