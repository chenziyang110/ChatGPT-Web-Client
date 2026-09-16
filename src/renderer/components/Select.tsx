import * as SelectPrimitive from '@radix-ui/react-select';
import { Icon } from './Icon';

export interface SelectOption { value: string; label: string }

export function Select({ label, value, options, onValueChange, disabled, placeholder = '请选择', className = '', open, onOpenChange }: {
  label: string; value: string; options: SelectOption[]; onValueChange: (value: string) => void;
  disabled?: boolean; placeholder?: string; className?: string; open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  return <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled || !options.length} open={open} onOpenChange={onOpenChange}>
    <SelectPrimitive.Trigger className={`ui-select ${className}`} aria-label={label} data-value={value}>
      <span className="ui-select-value"><SelectPrimitive.Value placeholder={placeholder} /></span>
      <SelectPrimitive.Icon className="ui-select-chevron"><Icon name="chevronDown" size={16} /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content className="ui-select-content" data-select-content="" position="popper" sideOffset={6} collisionPadding={12}
        onKeyDown={event => event.stopPropagation()} onEscapeKeyDown={event => event.stopPropagation()}>
        <SelectPrimitive.ScrollUpButton className="ui-select-scroll"><Icon name="chevronDown" size={14} className="up" /></SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="ui-select-viewport">
          {options.map(option => <SelectPrimitive.Item className="ui-select-item" key={option.value} value={option.value} data-value={option.value} textValue={option.label} title={option.label}>
            <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
            <SelectPrimitive.ItemIndicator className="ui-select-check"><Icon name="check" size={16} /></SelectPrimitive.ItemIndicator>
          </SelectPrimitive.Item>)}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="ui-select-scroll"><Icon name="chevronDown" size={14} /></SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  </SelectPrimitive.Root>;
}
