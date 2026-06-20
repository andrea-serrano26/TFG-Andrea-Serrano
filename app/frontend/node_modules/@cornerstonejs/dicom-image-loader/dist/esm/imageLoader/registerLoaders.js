import wadouriRegister from './wadouri/register';
import wadorsRegister from './wadors/register';
function registerLoaders() {
    wadorsRegister();
    wadouriRegister();
}
export default registerLoaders;
