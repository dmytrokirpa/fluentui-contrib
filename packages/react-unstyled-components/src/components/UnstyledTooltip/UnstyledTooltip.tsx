import {
  useTooltip_unstable,
  renderTooltip_unstable,
} from '@fluentui/react-components';
import type { JSXElement, TooltipProps } from '@fluentui/react-components';

export type UnstyledTooltipProps = Omit<TooltipProps, 'appearance'>;

export const UnstyledTooltip = (props: UnstyledTooltipProps): JSXElement => {
  const state = useTooltip_unstable(props);

  return renderTooltip_unstable(state);
};
